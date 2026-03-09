/**
 * BleTransport.ts - Send/receive messages over GATT with fragmentation
 *
 * Messages that exceed the negotiated BLE MTU are automatically split into
 * sequenced fragments and reassembled on the receiving side.
 *
 * Fragment header (2 bytes):
 *   [fragmentIndex: u8, totalFragments: u8, ...payload]
 *
 * The maximum payload per fragment is therefore (usableMTU - 2) bytes.
 *
 * Incomplete reassembly buffers are discarded after REASSEMBLY_TIMEOUT_MS
 * (10 seconds) to avoid memory leaks from lost fragments.
 */

import bleService, { type BleEventUnsubscribe } from './BleService';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Size of the per-fragment header: 1 byte index + 1 byte total. */
const FRAGMENT_HEADER_SIZE = 2;

/** Maximum number of fragments a single message can be split into (u8 max). */
const MAX_FRAGMENTS = 255;

/** Time (ms) to wait for all fragments before discarding a partial message. */
const REASSEMBLY_TIMEOUT_MS = 10_000;

/** Interval (ms) at which the reassembly sweep runs. */
const REASSEMBLY_SWEEP_INTERVAL_MS = 2_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MessageCallback = (peerId: string, data: Uint8Array) => void;

/** Internal bookkeeping for an in-progress fragment reassembly. */
interface ReassemblyBuffer {
  /** Total number of fragments expected. */
  totalFragments: number;
  /** Fragments received so far, indexed by fragmentIndex. */
  fragments: (Uint8Array | null)[];
  /** Number of fragments received. */
  receivedCount: number;
  /** Unix timestamp (ms) when the first fragment arrived. */
  startedAt: number;
}

/**
 * Unique key for a reassembly buffer. Because BLE is per-connection, a
 * single peer can only have one in-flight message at a time on a given
 * characteristic. We key by peerId.
 */
type ReassemblyKey = string;

// ---------------------------------------------------------------------------
// BleTransport
// ---------------------------------------------------------------------------

class BleTransport {
  // -- singleton ------------------------------------------------------------

  private static _instance: BleTransport | null = null;

  static getInstance(): BleTransport {
    if (!BleTransport._instance) {
      BleTransport._instance = new BleTransport();
    }
    return BleTransport._instance;
  }

  // -- state ----------------------------------------------------------------

  private _messageCallbacks: Set<MessageCallback> = new Set();
  private _reassembly: Map<ReassemblyKey, ReassemblyBuffer> = new Map();
  private _dataSubscription: BleEventUnsubscribe | null = null;
  private _sweepTimer: ReturnType<typeof setInterval> | null = null;
  private _started = false;

  private constructor() {}

  // -- lifecycle ------------------------------------------------------------

  /**
   * Begin listening for incoming BLE data and start the reassembly
   * sweep timer. Safe to call multiple times.
   */
  start(): void {
    if (this._started) {
      return;
    }

    this._dataSubscription = bleService.onDataReceived(
      this.handleIncomingData,
    );

    this._sweepTimer = setInterval(
      this.sweepStaleReassembly,
      REASSEMBLY_SWEEP_INTERVAL_MS,
    );

    this._started = true;
  }

  /**
   * Stop listening and clean up resources.
   */
  stop(): void {
    if (!this._started) {
      return;
    }

    this._dataSubscription?.();
    this._dataSubscription = null;

    if (this._sweepTimer !== null) {
      clearInterval(this._sweepTimer);
      this._sweepTimer = null;
    }

    this._reassembly.clear();
    this._started = false;
  }

  // -- send -----------------------------------------------------------------

  /**
   * Send a complete message to a connected peer. The message is automatically
   * fragmented if it exceeds the peer's usable MTU minus the fragment header.
   *
   * @param peerId  The BLE peripheral identifier of the target peer.
   * @param data    The raw message bytes to send.
   */
  async sendMessage(peerId: string, data: Uint8Array): Promise<void> {
    const usableMtu = bleService.getUsableMtu(peerId);
    const maxPayload = usableMtu - FRAGMENT_HEADER_SIZE;

    if (maxPayload <= 0) {
      throw new Error(
        `Usable MTU (${usableMtu}) is too small to fit the fragment header.`,
      );
    }

    const totalFragments = Math.ceil(data.length / maxPayload);

    if (totalFragments > MAX_FRAGMENTS) {
      throw new Error(
        `Message size ${data.length} bytes requires ${totalFragments} fragments, ` +
          `exceeding the maximum of ${MAX_FRAGMENTS}.`,
      );
    }

    // Single-fragment fast path: still include the header for consistency.
    for (let i = 0; i < totalFragments; i++) {
      const start = i * maxPayload;
      const end = Math.min(start + maxPayload, data.length);
      const payload = data.subarray(start, end);

      const fragment = new Uint8Array(FRAGMENT_HEADER_SIZE + payload.length);
      fragment[0] = i; // fragmentIndex
      fragment[1] = totalFragments; // totalFragments
      fragment.set(payload, FRAGMENT_HEADER_SIZE);

      await bleService.sendData(peerId, fragment);
    }
  }

  // -- receive --------------------------------------------------------------

  /**
   * Register a callback that fires when a complete (reassembled) message
   * is received from any peer.
   *
   * @returns An unsubscribe function.
   */
  onMessage(callback: MessageCallback): BleEventUnsubscribe {
    this._messageCallbacks.add(callback);
    return () => {
      this._messageCallbacks.delete(callback);
    };
  }

  // -- internal: incoming data handler --------------------------------------

  private handleIncomingData = (peerId: string, raw: Uint8Array): void => {
    if (raw.length < FRAGMENT_HEADER_SIZE) {
      // Malformed fragment -- ignore.
      return;
    }

    const fragmentIndex = raw[0];
    const totalFragments = raw[1];
    const payload = raw.subarray(FRAGMENT_HEADER_SIZE);

    // Validate header values.
    if (
      totalFragments === 0 ||
      fragmentIndex >= totalFragments ||
      totalFragments > MAX_FRAGMENTS
    ) {
      return;
    }

    // Fast path: single-fragment message.
    if (totalFragments === 1) {
      this.emitMessage(peerId, payload);
      return;
    }

    // Multi-fragment: upsert reassembly buffer.
    const key: ReassemblyKey = peerId;
    let buffer = this._reassembly.get(key);

    if (!buffer || buffer.totalFragments !== totalFragments) {
      // New message (or total changed, which means a new message started).
      buffer = {
        totalFragments,
        fragments: new Array<Uint8Array | null>(totalFragments).fill(null),
        receivedCount: 0,
        startedAt: Date.now(),
      };
      this._reassembly.set(key, buffer);
    }

    // Store fragment (ignore duplicates).
    if (buffer.fragments[fragmentIndex] === null) {
      buffer.fragments[fragmentIndex] = payload;
      buffer.receivedCount++;
    }

    // Check completeness.
    if (buffer.receivedCount === buffer.totalFragments) {
      this._reassembly.delete(key);
      const assembled = this.assembleFragments(buffer);
      if (assembled) {
        this.emitMessage(peerId, assembled);
      }
    }
  };

  // -- internal: reassembly helpers -----------------------------------------

  /**
   * Concatenate all fragment payloads into a single Uint8Array.
   * Returns null if any fragment is missing (should not happen if
   * receivedCount === totalFragments, but defensive).
   */
  private assembleFragments(buffer: ReassemblyBuffer): Uint8Array | null {
    let totalLength = 0;
    for (const frag of buffer.fragments) {
      if (!frag) {
        return null;
      }
      totalLength += frag.length;
    }

    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const frag of buffer.fragments) {
      // Already null-checked above.
      result.set(frag!, offset);
      offset += frag!.length;
    }

    return result;
  }

  /** Emit a fully reassembled message to all registered callbacks. */
  private emitMessage(peerId: string, data: Uint8Array): void {
    for (const cb of this._messageCallbacks) {
      try {
        cb(peerId, data);
      } catch {
        // Swallow listener errors.
      }
    }
  }

  // -- internal: sweep stale reassembly buffers -----------------------------

  private sweepStaleReassembly = (): void => {
    const now = Date.now();
    for (const [key, buffer] of this._reassembly) {
      if (now - buffer.startedAt >= REASSEMBLY_TIMEOUT_MS) {
        this._reassembly.delete(key);
      }
    }
  };
}

export default BleTransport;
