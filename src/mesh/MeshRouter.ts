/**
 * MeshRouter.ts - Managed flooding router for the Jisr BLE mesh.
 *
 * Routing strategy
 * ----------------
 * Every received packet is checked against a Bloom filter.  If the message
 * ID has already been seen the packet is silently dropped (dedup).  Otherwise
 * the ID is inserted into the filter and the packet is processed:
 *
 *   1. If `dst_id` matches our local ID prefix (or is the broadcast sentinel)
 *      the packet is delivered locally via the `onLocalDelivery` callback.
 *
 *   2. If the packet is *not* addressed exclusively to us (i.e. it is a
 *      broadcast, or addressed to someone else) and TTL > 0 after
 *      decrement, the packet is relayed to every connected peer except the
 *      sender.  A small random jitter (8-25 ms) is applied before each
 *      relay to prevent BLE broadcast storms.
 *
 * The router itself is transport-agnostic.  Callers must supply a
 * `sendToPeer` delegate that handles the actual BLE write.
 */

import { BloomFilter } from './BloomFilter';
import {
  MeshPacket,
  BROADCAST_DST,
  encode,
  decode,
} from './MeshProtocol';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum relay jitter in milliseconds. */
const MIN_JITTER_MS = 8;

/** Maximum relay jitter in milliseconds. */
const MAX_JITTER_MS = 25;

// ---------------------------------------------------------------------------
// Helper types
// ---------------------------------------------------------------------------

/** Callback invoked when a packet is destined for the local node. */
export type LocalDeliveryCallback = (packet: MeshPacket) => void;

/** Callback invoked after a packet has been relayed (for logging / metrics). */
export type RelayedPacketCallback = (packet: MeshPacket) => void;

/**
 * Transport-level delegate that the router calls to push raw bytes to a
 * specific connected peer.  The implementation is expected to write to the
 * appropriate BLE GATT characteristic.
 */
export type SendToPeerFn = (peerId: string, data: Uint8Array) => void;

/** Accumulated routing statistics. */
export interface RouterStats {
  /** Total packets accepted and forwarded to at least one peer. */
  packetsRouted: number;
  /** Total packets dropped (duplicates / expired TTL). */
  packetsDropped: number;
  /** Total packets delivered to the local node. */
  packetsDelivered: number;
}

// ---------------------------------------------------------------------------
// MeshRouter
// ---------------------------------------------------------------------------

export class MeshRouter {
  // Deduplication
  private bloom: BloomFilter;

  // Identity
  private localId: Uint8Array | null = null;

  // Connected peers (peer BLE id -> true).  The router does not own this
  // list -- callers are expected to keep it in sync via add/remove helpers.
  private connectedPeers: Set<string> = new Set();

  // Transport delegate
  private sendToPeer: SendToPeerFn;

  // Callbacks
  public onLocalDelivery: LocalDeliveryCallback | null = null;
  public onRelayedPacket: RelayedPacketCallback | null = null;

  // Statistics
  private stats: RouterStats = {
    packetsRouted: 0,
    packetsDropped: 0,
    packetsDelivered: 0,
  };

  constructor(sendToPeer: SendToPeerFn) {
    this.bloom = new BloomFilter();
    this.sendToPeer = sendToPeer;
  }

  // -----------------------------------------------------------------------
  // Identity
  // -----------------------------------------------------------------------

  /**
   * Set the local 4-byte ID prefix derived from the node's public key hash.
   * This MUST be called before the router can deliver packets locally.
   */
  setLocalId(id: Uint8Array): void {
    if (id.length !== 4) {
      throw new RangeError(`localId must be 4 bytes, got ${id.length}`);
    }
    this.localId = new Uint8Array(id);
  }

  // -----------------------------------------------------------------------
  // Peer management (thin wrappers so the router knows who is connected)
  // -----------------------------------------------------------------------

  addPeer(peerId: string): void {
    this.connectedPeers.add(peerId);
  }

  removePeer(peerId: string): void {
    this.connectedPeers.delete(peerId);
  }

  getPeers(): ReadonlySet<string> {
    return this.connectedPeers;
  }

  // -----------------------------------------------------------------------
  // Inbound path
  // -----------------------------------------------------------------------

  /**
   * Process a packet received from a connected peer.
   *
   * @param rawOrPacket  Either raw bytes (Uint8Array) or an already-decoded
   *                     MeshPacket.  If raw bytes are supplied the method
   *                     decodes them first; any parse error causes a silent
   *                     drop (logged to console.warn).
   * @param fromPeerId   BLE identifier of the peer that sent the packet.
   */
  handleIncomingPacket(
    rawOrPacket: Uint8Array | MeshPacket,
    fromPeerId: string,
  ): void {
    let packet: MeshPacket;

    if (rawOrPacket instanceof Uint8Array) {
      try {
        packet = decode(rawOrPacket);
      } catch (err) {
        console.warn('[MeshRouter] Dropping malformed packet:', err);
        this.stats.packetsDropped++;
        return;
      }
    } else {
      packet = rawOrPacket;
    }

    // --- Deduplication ---
    if (this.bloom.has(packet.msgId)) {
      this.stats.packetsDropped++;
      return;
    }
    this.bloom.add(packet.msgId);

    // --- Local delivery ---
    const isForUs = this.isAddressedToUs(packet.dstId);
    const isBroadcast = this.isBroadcast(packet.dstId);

    if (isForUs || isBroadcast) {
      this.stats.packetsDelivered++;
      if (this.onLocalDelivery) {
        try {
          this.onLocalDelivery(packet);
        } catch (err) {
          console.error('[MeshRouter] onLocalDelivery threw:', err);
        }
      }
    }

    // If the packet is exclusively for us (unicast match) do not relay.
    if (isForUs && !isBroadcast) {
      return;
    }

    // --- Relay ---
    const newTtl = packet.ttl - 1;
    if (newTtl <= 0) {
      // TTL exhausted -- do not relay.
      return;
    }

    // Build the relayed packet (decrement TTL, increment hopCount).
    const relayPacket: MeshPacket = {
      ...packet,
      ttl: newTtl,
      hopCount: packet.hopCount + 1,
    };

    const relayData = encode(relayPacket);

    // Relay to every connected peer except the sender.
    for (const peerId of this.connectedPeers) {
      if (peerId === fromPeerId) {
        continue;
      }
      this.scheduleRelay(peerId, relayData, relayPacket);
    }
  }

  // -----------------------------------------------------------------------
  // Outbound path
  // -----------------------------------------------------------------------

  /**
   * Originate a packet from this node.  The packet's msgId is added to the
   * Bloom filter immediately (so that echoes from peers are dropped) and
   * the encoded frame is sent to all connected peers.
   */
  sendPacket(packet: MeshPacket): void {
    // Record in bloom so we ignore our own echoes.
    this.bloom.add(packet.msgId);

    const data = encode(packet);

    for (const peerId of this.connectedPeers) {
      this.scheduleRelay(peerId, data, packet);
    }
  }

  // -----------------------------------------------------------------------
  // Stats
  // -----------------------------------------------------------------------

  getStats(): Readonly<RouterStats> {
    return { ...this.stats };
  }

  resetStats(): void {
    this.stats.packetsRouted = 0;
    this.stats.packetsDropped = 0;
    this.stats.packetsDelivered = 0;
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  /** Compare a destination prefix with our local ID. */
  private isAddressedToUs(dstId: Uint8Array): boolean {
    if (!this.localId) {
      return false;
    }
    return (
      dstId[0] === this.localId[0] &&
      dstId[1] === this.localId[1] &&
      dstId[2] === this.localId[2] &&
      dstId[3] === this.localId[3]
    );
  }

  /** Check whether a destination is the broadcast sentinel. */
  private isBroadcast(dstId: Uint8Array): boolean {
    return (
      dstId[0] === BROADCAST_DST[0] &&
      dstId[1] === BROADCAST_DST[1] &&
      dstId[2] === BROADCAST_DST[2] &&
      dstId[3] === BROADCAST_DST[3]
    );
  }

  /**
   * Schedule a relay transmission with random jitter to prevent
   * BLE broadcast storms when many nodes try to relay simultaneously.
   */
  private scheduleRelay(
    peerId: string,
    data: Uint8Array,
    packet: MeshPacket,
  ): void {
    const jitter =
      MIN_JITTER_MS + Math.random() * (MAX_JITTER_MS - MIN_JITTER_MS);

    setTimeout(() => {
      try {
        this.sendToPeer(peerId, data);
        this.stats.packetsRouted++;
        if (this.onRelayedPacket) {
          this.onRelayedPacket(packet);
        }
      } catch (err) {
        console.error(`[MeshRouter] Failed to relay to ${peerId}:`, err);
      }
    }, jitter);
  }
}
