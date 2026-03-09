/**
 * PeerDiscovery.ts - Track nearby BLE peers
 *
 * Maintains a real-time registry of discovered Jisr BLE peers.
 * Peers are automatically evicted when they have not been seen
 * for PEER_TIMEOUT_MS (30 seconds).
 *
 * Usage:
 *   const discovery = PeerDiscovery.getInstance();
 *   discovery.start();
 *   const peers = discovery.getActivePeers();
 */

import bleService, {
  type BleConnectionEvent,
  type BleConnectionState,
  type BleEventUnsubscribe,
  type BlePeerEvent,
} from './BleService';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Time (ms) after which a peer is considered gone if not re-advertised. */
const PEER_TIMEOUT_MS = 30_000;

/** Interval (ms) at which the stale-peer sweep runs. */
const SWEEP_INTERVAL_MS = 5_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PeerInfo {
  /** Stable peer identifier (BLE peripheral id or PEER_ID characteristic). */
  peerId: string;
  /** Human-readable name from the advertisement local name. */
  displayName: string;
  /** Last observed RSSI value (dBm). */
  rssi: number;
  /** Unix timestamp (ms) of the most recent advertisement or data exchange. */
  lastSeen: number;
  /** Current connection state to this peer. */
  connectionState: BleConnectionState;
}

export type PeerChangeCallback = (peers: PeerInfo[]) => void;

// ---------------------------------------------------------------------------
// PeerDiscovery
// ---------------------------------------------------------------------------

class PeerDiscovery {
  // -- singleton ------------------------------------------------------------

  private static _instance: PeerDiscovery | null = null;

  static getInstance(): PeerDiscovery {
    if (!PeerDiscovery._instance) {
      PeerDiscovery._instance = new PeerDiscovery();
    }
    return PeerDiscovery._instance;
  }

  // -- state ----------------------------------------------------------------

  private _peers: Map<string, PeerInfo> = new Map();
  private _listeners: Set<PeerChangeCallback> = new Set();
  private _subscriptions: BleEventUnsubscribe[] = [];
  private _sweepTimer: ReturnType<typeof setInterval> | null = null;
  private _started = false;

  private constructor() {}

  // -- lifecycle ------------------------------------------------------------

  /**
   * Start listening for BLE discovery and connection-state events.
   * Also begins the periodic sweep for stale peers.
   * Safe to call multiple times (subsequent calls are no-ops).
   */
  start(): void {
    if (this._started) {
      return;
    }

    this._subscriptions.push(
      bleService.onPeerDiscovered(this.handlePeerDiscovered),
      bleService.onPeerLost(this.handlePeerLost),
      bleService.onConnectionStateChanged(this.handleConnectionStateChanged),
    );

    this._sweepTimer = setInterval(this.sweepStalePeers, SWEEP_INTERVAL_MS);
    this._started = true;
  }

  /**
   * Stop listening and clean up timers. Clears the peer map.
   */
  stop(): void {
    if (!this._started) {
      return;
    }

    for (const unsub of this._subscriptions) {
      unsub();
    }
    this._subscriptions = [];

    if (this._sweepTimer !== null) {
      clearInterval(this._sweepTimer);
      this._sweepTimer = null;
    }

    this._peers.clear();
    this._started = false;
    this.notifyListeners();
  }

  // -- queries --------------------------------------------------------------

  /** Return a snapshot array of all active (non-stale) peers. */
  getActivePeers(): PeerInfo[] {
    return Array.from(this._peers.values());
  }

  /** Look up a single peer by id. Returns undefined if not tracked. */
  getPeerById(peerId: string): PeerInfo | undefined {
    return this._peers.get(peerId);
  }

  /**
   * Whether a peer is currently in the discovered set *and* is either
   * connected or was seen recently enough to still be in range.
   */
  isDirectlyReachable(peerId: string): boolean {
    const peer = this._peers.get(peerId);
    if (!peer) {
      return false;
    }
    if (peer.connectionState === 'connected') {
      return true;
    }
    return Date.now() - peer.lastSeen < PEER_TIMEOUT_MS;
  }

  // -- change subscription --------------------------------------------------

  /**
   * Register a callback that fires whenever the peer list changes
   * (discovery, loss, state change, or sweep).
   *
   * @returns An unsubscribe function.
   */
  onChange(callback: PeerChangeCallback): BleEventUnsubscribe {
    this._listeners.add(callback);
    return () => {
      this._listeners.delete(callback);
    };
  }

  // -- event handlers -------------------------------------------------------

  private handlePeerDiscovered = (event: BlePeerEvent): void => {
    const existing = this._peers.get(event.peerId);

    const updated: PeerInfo = {
      peerId: event.peerId,
      displayName: event.displayName,
      rssi: event.rssi,
      lastSeen: Date.now(),
      connectionState: existing?.connectionState ?? 'disconnected',
    };

    this._peers.set(event.peerId, updated);
    this.notifyListeners();
  };

  private handlePeerLost = (event: { peerId: string }): void => {
    if (this._peers.has(event.peerId)) {
      this._peers.delete(event.peerId);
      this.notifyListeners();
    }
  };

  private handleConnectionStateChanged = (event: BleConnectionEvent): void => {
    const peer = this._peers.get(event.peerId);
    if (!peer) {
      // We may receive a connection event for a peer that was already swept.
      // If the state is "connected" we re-add it with minimal info.
      if (event.state === 'connected' || event.state === 'connecting') {
        this._peers.set(event.peerId, {
          peerId: event.peerId,
          displayName: '',
          rssi: 0,
          lastSeen: Date.now(),
          connectionState: event.state,
        });
        this.notifyListeners();
      }
      return;
    }

    peer.connectionState = event.state;
    peer.lastSeen = Date.now();

    // If the peer disconnected and has no recent advertisement, remove it.
    if (event.state === 'disconnected') {
      const age = Date.now() - peer.lastSeen;
      if (age >= PEER_TIMEOUT_MS) {
        this._peers.delete(event.peerId);
      }
    }

    this.notifyListeners();
  };

  // -- internal helpers -----------------------------------------------------

  /** Remove peers that have not been seen within PEER_TIMEOUT_MS. */
  private sweepStalePeers = (): void => {
    const now = Date.now();
    let changed = false;

    for (const [id, peer] of this._peers) {
      // Do not evict peers that are still connected.
      if (peer.connectionState === 'connected') {
        continue;
      }
      if (now - peer.lastSeen >= PEER_TIMEOUT_MS) {
        this._peers.delete(id);
        changed = true;
      }
    }

    if (changed) {
      this.notifyListeners();
    }
  };

  /** Notify all registered listeners with the current peer snapshot. */
  private notifyListeners(): void {
    const snapshot = this.getActivePeers();
    for (const cb of this._listeners) {
      try {
        cb(snapshot);
      } catch {
        // Swallow listener errors to prevent cascading failures.
      }
    }
  }
}

export default PeerDiscovery;
