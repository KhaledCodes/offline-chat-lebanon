/**
 * PeerTable.ts - Track known peers in the Jisr BLE mesh network.
 *
 * The table stores metadata about every peer the node has learned about,
 * whether through a direct BLE connection or via multi-hop ANNOUNCE /
 * PEER_EXCHANGE packets.  It supports fast lookup by both BLE peripheral
 * identifier (`peerId`) and by the 4-byte ID prefix derived from the
 * peer's public key hash.
 *
 * Staleness policy:
 *   - Direct peers  : stale after 5 minutes without contact.
 *   - Relay peers   : stale after 2 minutes without contact.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default stale threshold for directly connected peers (ms). */
const DIRECT_STALE_MS = 5 * 60 * 1000; // 5 minutes

/** Default stale threshold for relay (multi-hop) peers (ms). */
const RELAY_STALE_MS = 2 * 60 * 1000; // 2 minutes

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Information stored about a single peer. */
export interface PeerInfo {
  /** BLE peripheral identifier (platform-specific string). */
  peerId: string;

  /** First 4 bytes of the SHA-256 of the peer's public key. */
  idPrefix: Uint8Array; // 4 bytes

  /** Timestamp (ms since epoch) of the last packet received from / about this peer. */
  lastSeen: number;

  /** Number of hops to reach this peer (0 = direct connection). */
  hopCount: number;

  /** Whether we currently hold an active BLE connection to this peer. */
  directlyConnected: boolean;

  /** Most recent BLE RSSI reading (dBm), or null if unknown / relay peer. */
  rssi: number | null;
}

/** Subset of PeerInfo fields accepted by `addOrUpdate`. */
export interface PeerUpdate {
  peerId: string;
  idPrefix: Uint8Array;
  hopCount: number;
  directlyConnected: boolean;
  rssi?: number | null;
}

// ---------------------------------------------------------------------------
// PeerTable
// ---------------------------------------------------------------------------

export class PeerTable {
  /**
   * Primary store keyed by `peerId`.
   *
   * We keep a Map rather than a plain object so that iteration order is
   * insertion-order, which is handy for consistent UI rendering.
   */
  private peers: Map<string, PeerInfo> = new Map();

  /**
   * Secondary index: 4-byte prefix (encoded as a hex string) -> peerId.
   *
   * Because multiple peers could theoretically share the same 4-byte prefix
   * (birthday collisions are unlikely but possible at ~65 k peers), we map
   * to an *array* of peerIds.
   */
  private prefixIndex: Map<string, string[]> = new Map();

  // -----------------------------------------------------------------------
  // Mutations
  // -----------------------------------------------------------------------

  /**
   * Insert a new peer or update an existing one.
   *
   * Update semantics:
   *   - `lastSeen` is always refreshed to `Date.now()`.
   *   - If the new `hopCount` is *lower* than the stored one, or the peer
   *     was previously an indirect peer and is now directly connected, the
   *     record is updated.  This ensures the table converges on the
   *     shortest known path.
   *   - RSSI is updated whenever a new reading is provided.
   */
  addOrUpdate(info: PeerUpdate): PeerInfo {
    const { peerId, idPrefix, hopCount, directlyConnected, rssi } = info;

    if (idPrefix.length !== 4) {
      throw new RangeError(`idPrefix must be 4 bytes, got ${idPrefix.length}`);
    }

    const now = Date.now();
    const existing = this.peers.get(peerId);

    if (existing) {
      existing.lastSeen = now;

      // Prefer routes with fewer hops.
      if (hopCount < existing.hopCount || directlyConnected) {
        existing.hopCount = hopCount;
        existing.directlyConnected = directlyConnected;
      }

      if (rssi !== undefined) {
        existing.rssi = rssi ?? existing.rssi;
      }

      // If the prefix changed (key rotation), update the secondary index.
      if (!prefixEquals(existing.idPrefix, idPrefix)) {
        this.removePrefixIndex(existing.peerId, existing.idPrefix);
        existing.idPrefix = new Uint8Array(idPrefix);
        this.addPrefixIndex(peerId, idPrefix);
      }

      return existing;
    }

    // New peer.
    const entry: PeerInfo = {
      peerId,
      idPrefix: new Uint8Array(idPrefix),
      lastSeen: now,
      hopCount,
      directlyConnected,
      rssi: rssi ?? null,
    };

    this.peers.set(peerId, entry);
    this.addPrefixIndex(peerId, idPrefix);

    return entry;
  }

  /**
   * Remove a peer by its BLE identifier.
   * @returns `true` if the peer existed and was removed.
   */
  remove(peerId: string): boolean {
    const entry = this.peers.get(peerId);
    if (!entry) {
      return false;
    }

    this.removePrefixIndex(peerId, entry.idPrefix);
    this.peers.delete(peerId);
    return true;
  }

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  /**
   * Return all peers that are directly connected over BLE.
   */
  getDirectPeers(): PeerInfo[] {
    const result: PeerInfo[] = [];
    for (const peer of this.peers.values()) {
      if (peer.directlyConnected) {
        result.push(peer);
      }
    }
    return result;
  }

  /**
   * Return all peers known to the table, both direct and multi-hop.
   */
  getReachablePeers(): PeerInfo[] {
    return Array.from(this.peers.values());
  }

  /**
   * Look up a peer by its 4-byte ID prefix.
   *
   * Returns the first match (direct peers preferred over relay peers).
   * Returns `null` if no peer with the given prefix is known.
   */
  getPeerByIdPrefix(prefix: Uint8Array): PeerInfo | null {
    if (prefix.length !== 4) {
      throw new RangeError(`prefix must be 4 bytes, got ${prefix.length}`);
    }

    const key = prefixToHex(prefix);
    const peerIds = this.prefixIndex.get(key);

    if (!peerIds || peerIds.length === 0) {
      return null;
    }

    // Prefer directly connected peers when there are collisions.
    let best: PeerInfo | null = null;
    for (const pid of peerIds) {
      const entry = this.peers.get(pid);
      if (!entry) continue;
      if (!best || entry.directlyConnected || entry.hopCount < best.hopCount) {
        best = entry;
      }
    }

    return best;
  }

  /**
   * Get a specific peer by its BLE identifier.
   */
  getPeer(peerId: string): PeerInfo | null {
    return this.peers.get(peerId) ?? null;
  }

  /**
   * Return the total number of peers in the table.
   */
  get size(): number {
    return this.peers.size;
  }

  // -----------------------------------------------------------------------
  // Maintenance
  // -----------------------------------------------------------------------

  /**
   * Remove peers that have not been seen within the allowed window.
   *
   * @param maxAgeMs  Optional override for the stale threshold.  If
   *                  omitted the default policy is used (5 min direct,
   *                  2 min relay).
   * @returns         The number of peers pruned.
   */
  pruneStale(maxAgeMs?: number): number {
    const now = Date.now();
    const toPrune: string[] = [];

    for (const [peerId, peer] of this.peers) {
      const threshold = maxAgeMs ?? (peer.directlyConnected
        ? DIRECT_STALE_MS
        : RELAY_STALE_MS);

      if (now - peer.lastSeen > threshold) {
        toPrune.push(peerId);
      }
    }

    for (const peerId of toPrune) {
      this.remove(peerId);
    }

    return toPrune.length;
  }

  /**
   * Mark a peer as disconnected (no longer directly connected).
   * The peer remains in the table as a relay entry so that queued
   * messages can still be matched against it.
   */
  markDisconnected(peerId: string): void {
    const entry = this.peers.get(peerId);
    if (entry) {
      entry.directlyConnected = false;
      entry.rssi = null;
    }
  }

  /**
   * Remove all entries from the table.
   */
  clear(): void {
    this.peers.clear();
    this.prefixIndex.clear();
  }

  // -----------------------------------------------------------------------
  // Prefix index helpers
  // -----------------------------------------------------------------------

  private addPrefixIndex(peerId: string, prefix: Uint8Array): void {
    const key = prefixToHex(prefix);
    const list = this.prefixIndex.get(key);
    if (list) {
      if (!list.includes(peerId)) {
        list.push(peerId);
      }
    } else {
      this.prefixIndex.set(key, [peerId]);
    }
  }

  private removePrefixIndex(peerId: string, prefix: Uint8Array): void {
    const key = prefixToHex(prefix);
    const list = this.prefixIndex.get(key);
    if (!list) return;

    const idx = list.indexOf(peerId);
    if (idx !== -1) {
      list.splice(idx, 1);
    }
    if (list.length === 0) {
      this.prefixIndex.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a 4-byte Uint8Array to an 8-character hex string for map keys. */
function prefixToHex(prefix: Uint8Array): string {
  // Manual hex encoding is faster than Array.from + map + join in hot paths.
  const HEX = '0123456789abcdef';
  return (
    HEX[prefix[0] >> 4] + HEX[prefix[0] & 0xf] +
    HEX[prefix[1] >> 4] + HEX[prefix[1] & 0xf] +
    HEX[prefix[2] >> 4] + HEX[prefix[2] & 0xf] +
    HEX[prefix[3] >> 4] + HEX[prefix[3] & 0xf]
  );
}

/** Byte-by-byte comparison of two 4-byte prefixes. */
function prefixEquals(a: Uint8Array, b: Uint8Array): boolean {
  return (
    a[0] === b[0] &&
    a[1] === b[1] &&
    a[2] === b[2] &&
    a[3] === b[3]
  );
}
