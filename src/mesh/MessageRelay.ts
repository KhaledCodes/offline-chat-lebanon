/**
 * MessageRelay.ts - Store-and-forward queue for offline peers.
 *
 * When a message cannot be delivered because the destination peer is not
 * currently connected, the encoded packet is cached here.  When that peer
 * later reconnects the queue is flushed to it.
 *
 * Constraints:
 *   - Maximum 500 cached messages across all peers.
 *   - Individual messages expire after 1 hour.
 *   - A background prune timer runs every 5 minutes to evict stale entries.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of messages held in the relay queue. */
const MAX_QUEUE_SIZE = 500;

/** Time-to-live for a queued message in milliseconds (1 hour). */
const MESSAGE_TTL_MS = 60 * 60 * 1000;

/** Interval between automatic prune cycles in milliseconds (5 minutes). */
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface QueuedMessage {
  /** Raw encoded packet bytes ready for transmission. */
  packet: Uint8Array;

  /** Destination 4-byte ID prefix (used for lookup on peer connect). */
  dstId: Uint8Array;

  /** Timestamp (ms since epoch) at which the message was queued. */
  queuedAt: number;
}

// ---------------------------------------------------------------------------
// Transport delegate
// ---------------------------------------------------------------------------

/**
 * Callback used to actually push a stored packet to a peer once it
 * reconnects.  The MessageRelay does not own the BLE transport -- the
 * caller provides this delegate.
 */
export type SendToPeerFn = (peerId: string, data: Uint8Array) => void;

// ---------------------------------------------------------------------------
// MessageRelay
// ---------------------------------------------------------------------------

export class MessageRelay {
  /** FIFO queue of stored messages. */
  private queue: QueuedMessage[] = [];

  /** Transport delegate supplied at construction time. */
  private sendToPeer: SendToPeerFn;

  /** Handle for the periodic prune timer (so we can clear it on destroy). */
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(sendToPeer: SendToPeerFn) {
    this.sendToPeer = sendToPeer;
    this.startPruneTimer();
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Enqueue an encoded packet for later delivery to the peer identified
   * by `dstId` (4-byte prefix).
   *
   * If the queue is full the oldest message is evicted to make room.
   */
  queueForPeer(dstId: Uint8Array, packet: Uint8Array): void {
    if (dstId.length !== 4) {
      throw new RangeError(`dstId must be 4 bytes, got ${dstId.length}`);
    }

    // Evict oldest if at capacity.
    while (this.queue.length >= MAX_QUEUE_SIZE) {
      this.queue.shift();
    }

    this.queue.push({
      packet: new Uint8Array(packet), // defensive copy
      dstId: new Uint8Array(dstId),
      queuedAt: Date.now(),
    });
  }

  /**
   * Called when a peer (re)connects.  Flushes all queued messages whose
   * `dstId` matches `peerIdPrefix` by sending them through the transport
   * delegate and removing them from the queue.
   *
   * @param peerId         BLE identifier of the connected peer (passed
   *                       through to the send delegate).
   * @param peerIdPrefix   4-byte prefix derived from the peer's public key
   *                       hash -- used to match against queued `dstId`s.
   */
  onPeerConnected(peerId: string, peerIdPrefix: Uint8Array): void {
    if (peerIdPrefix.length !== 4) {
      throw new RangeError(
        `peerIdPrefix must be 4 bytes, got ${peerIdPrefix.length}`,
      );
    }

    const now = Date.now();
    const remaining: QueuedMessage[] = [];

    for (const msg of this.queue) {
      // Skip expired messages.
      if (now - msg.queuedAt > MESSAGE_TTL_MS) {
        continue;
      }

      // Check if this message is destined for the reconnected peer.
      if (prefixEquals(msg.dstId, peerIdPrefix)) {
        try {
          this.sendToPeer(peerId, msg.packet);
        } catch (err) {
          console.error(
            `[MessageRelay] Failed to flush queued message to ${peerId}:`,
            err,
          );
          // Keep the message in the queue so we can retry later.
          remaining.push(msg);
        }
      } else {
        remaining.push(msg);
      }
    }

    this.queue = remaining;
  }

  /**
   * Return the current number of messages in the relay queue.
   */
  getQueueSize(): number {
    return this.queue.length;
  }

  /**
   * Remove all messages whose TTL has expired.
   * @returns The number of messages pruned.
   */
  pruneExpired(): number {
    const now = Date.now();
    const before = this.queue.length;

    this.queue = this.queue.filter(
      (msg) => now - msg.queuedAt <= MESSAGE_TTL_MS,
    );

    return before - this.queue.length;
  }

  /**
   * Tear down the relay.  Stops the background prune timer and clears the
   * queue.  Call this when the mesh layer is shutting down.
   */
  destroy(): void {
    this.stopPruneTimer();
    this.queue = [];
  }

  // -----------------------------------------------------------------------
  // Diagnostics
  // -----------------------------------------------------------------------

  /**
   * Return the number of queued messages targeting a specific destination
   * prefix.  Useful for UI indicators ("3 messages pending for this peer").
   */
  getQueueSizeForPeer(dstId: Uint8Array): number {
    let count = 0;
    for (const msg of this.queue) {
      if (prefixEquals(msg.dstId, dstId)) {
        count++;
      }
    }
    return count;
  }

  // -----------------------------------------------------------------------
  // Timer management
  // -----------------------------------------------------------------------

  private startPruneTimer(): void {
    if (this.pruneTimer !== null) {
      return;
    }
    this.pruneTimer = setInterval(() => {
      const pruned = this.pruneExpired();
      if (pruned > 0) {
        console.log(`[MessageRelay] Pruned ${pruned} expired messages`);
      }
    }, PRUNE_INTERVAL_MS);

    // In Node / React-Native the timer should not prevent the process from
    // exiting.  `unref` is available on Node timers but not in all RN
    // environments, so guard it.
    if (
      this.pruneTimer &&
      typeof (this.pruneTimer as any).unref === 'function'
    ) {
      (this.pruneTimer as any).unref();
    }
  }

  private stopPruneTimer(): void {
    if (this.pruneTimer !== null) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Constant-time-ish 4-byte prefix comparison. */
function prefixEquals(a: Uint8Array, b: Uint8Array): boolean {
  return (
    a[0] === b[0] &&
    a[1] === b[1] &&
    a[2] === b[2] &&
    a[3] === b[3]
  );
}
