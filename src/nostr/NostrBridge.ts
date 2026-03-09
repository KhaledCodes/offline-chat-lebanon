/**
 * NostrBridge.ts - Bridge between the BLE mesh network and Nostr relays.
 *
 * Provides a unified messaging interface that automatically routes messages
 * through Nostr relays when internet connectivity is available, and queues
 * them for later delivery when offline.
 *
 * Connectivity detection uses React Native's AppState and NetInfo pattern
 * to monitor network changes. When the device transitions from offline to
 * online, the queued messages are automatically flushed via Nostr.
 *
 * Incoming Nostr DMs (kind 1059 gift wraps) are automatically decrypted
 * and forwarded to registered message handlers, providing seamless
 * integration with the mesh-side message flow.
 */

import nostrClient, { type NostrEvent, type Filter } from './NostrClient';
import relayManager from './RelayManager';
import EventBuilder from './EventBuilder';
import { bytesToHex } from '@noble/hashes/utils';
import { getPublicKey } from 'nostr-tools/pure';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A message queued for delivery when connectivity is restored. */
interface QueuedMessage {
  /** Hex-encoded public key of the recipient. */
  recipientPubkey: string;
  /** Plaintext message content. */
  content: string;
  /** Timestamp (ms) when the message was queued. */
  queuedAt: number;
  /** Number of delivery attempts so far. */
  attempts: number;
}

/** Callback signature for incoming message notifications. */
type MessageReceivedCallback = (
  senderPubkey: string,
  content: string,
  timestamp: number,
) => void;

/** Connectivity state. */
type ConnectivityState = 'online' | 'offline' | 'unknown';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of messages to hold in the outbound queue. */
const MAX_QUEUE_SIZE = 500;

/** Maximum number of delivery attempts before a message is discarded. */
const MAX_DELIVERY_ATTEMPTS = 5;

/** Interval (ms) for polling connectivity status as a fallback. */
const CONNECTIVITY_POLL_INTERVAL_MS = 15_000;

/** Kind number for NIP-17 gift wraps that we subscribe to. */
const KIND_GIFT_WRAP = 1059;

/**
 * Set of event IDs we have already processed, to prevent duplicate
 * delivery when multiple relays forward the same event.
 */
const SEEN_EVENT_IDS_MAX = 2_000;

// ---------------------------------------------------------------------------
// NostrBridge
// ---------------------------------------------------------------------------

/**
 * Bridges the local mesh messaging layer with the Nostr relay network.
 *
 * When the device has internet connectivity, messages are sent immediately
 * as NIP-17 gift-wrapped DMs. When offline, messages are queued and
 * flushed automatically once connectivity is restored.
 */
class NostrBridge {
  // -- state ----------------------------------------------------------------

  /** Hex-encoded public key of the local user. */
  private pubkey: string = '';

  /** 32-byte private key of the local user. */
  private privkey: Uint8Array = new Uint8Array(0);

  /** Whether the bridge has been initialised. */
  private initialized = false;

  /** Current connectivity state. */
  private connectivity: ConnectivityState = 'unknown';

  /** Outbound message queue (FIFO). */
  private queue: QueuedMessage[] = [];

  /** Registered message-received callbacks. */
  private messageCallbacks: MessageReceivedCallback[] = [];

  /** Active Nostr subscription ID for incoming DMs. */
  private dmSubscriptionId: string | null = null;

  /** Connectivity polling timer. */
  private connectivityTimer: ReturnType<typeof setInterval> | null = null;

  /** De-duplication set for processed event IDs. */
  private seenEventIds: Set<string> = new Set();

  /** Queue of seen IDs in insertion order for eviction. */
  private seenEventIdOrder: string[] = [];

  /** NetInfo unsubscribe function, if available. */
  private netInfoUnsubscribe: (() => void) | null = null;

  // -- lifecycle ------------------------------------------------------------

  /**
   * Initialise the bridge with the user's identity.
   *
   * Sets up relay connections, subscribes for incoming DMs, and begins
   * monitoring connectivity.
   *
   * @param pubkey   Hex-encoded public key (may be derived from privkey).
   * @param privkey  32-byte private key.
   */
  initialize(pubkey: string, privkey: Uint8Array): void {
    if (this.initialized) {
      return;
    }

    this.pubkey = pubkey;
    this.privkey = privkey;
    this.initialized = true;

    // Start connectivity monitoring.
    this.startConnectivityMonitoring();

    // Attempt initial relay connection.
    this.goOnline().catch(() => {
      // Will retry on connectivity change.
    });
  }

  /**
   * Tear down the bridge: unsubscribe, disconnect relays, clear timers.
   */
  destroy(): void {
    if (this.dmSubscriptionId) {
      nostrClient.unsubscribe(this.dmSubscriptionId);
      this.dmSubscriptionId = null;
    }

    this.stopConnectivityMonitoring();
    relayManager.stop();

    this.initialized = false;
    this.messageCallbacks = [];
    this.seenEventIds.clear();
    this.seenEventIdOrder = [];
  }

  // -- public API -----------------------------------------------------------

  /**
   * Send a direct message to a recipient.
   *
   * If online, the message is sent immediately via Nostr. If offline, it
   * is added to the outbound queue for later delivery.
   *
   * @param recipientPubkey  Hex-encoded public key of the recipient.
   * @param content          Plaintext message content.
   * @returns true if the message was sent (or queued) successfully.
   */
  async sendMessage(
    recipientPubkey: string,
    content: string,
  ): Promise<boolean> {
    this.ensureInitialized();

    if (this.connectivity === 'online' && nostrClient.isConnected()) {
      // Attempt immediate delivery.
      try {
        const event = await EventBuilder.buildDirectMessage(
          content,
          recipientPubkey,
          this.privkey,
        );
        await nostrClient.publish(event);
        return true;
      } catch {
        // Delivery failed -- fall through to queue.
      }
    }

    // Queue the message for later delivery.
    return this.enqueue(recipientPubkey, content);
  }

  /**
   * Register a callback that fires when a DM is received from Nostr.
   *
   * @param callback  Function invoked with (senderPubkey, content, timestamp).
   */
  onMessageReceived(callback: MessageReceivedCallback): void {
    this.messageCallbacks.push(callback);
  }

  /**
   * Remove a previously registered message callback.
   */
  offMessageReceived(callback: MessageReceivedCallback): void {
    this.messageCallbacks = this.messageCallbacks.filter((cb) => cb !== callback);
  }

  /**
   * Returns the current connectivity state.
   */
  isOnline(): boolean {
    return this.connectivity === 'online';
  }

  /**
   * Manually flush the outbound message queue.
   *
   * Attempts to deliver all queued messages via Nostr. Messages that fail
   * delivery are re-queued if under the retry limit.
   *
   * @returns The number of messages successfully delivered.
   */
  async flushQueue(): Promise<number> {
    this.ensureInitialized();

    if (!nostrClient.isConnected()) {
      return 0;
    }

    const toSend = [...this.queue];
    this.queue = [];

    let delivered = 0;
    const retryQueue: QueuedMessage[] = [];

    for (const msg of toSend) {
      try {
        const event = await EventBuilder.buildDirectMessage(
          msg.content,
          msg.recipientPubkey,
          this.privkey,
        );
        await nostrClient.publish(event);
        delivered += 1;
      } catch {
        // Re-queue if under retry limit.
        msg.attempts += 1;
        if (msg.attempts < MAX_DELIVERY_ATTEMPTS) {
          retryQueue.push(msg);
        }
        // Otherwise the message is silently dropped.
      }
    }

    // Prepend failed messages back to the queue.
    this.queue = [...retryQueue, ...this.queue];
    return delivered;
  }

  /**
   * Return the number of messages currently in the outbound queue.
   */
  getQueueSize(): number {
    return this.queue.length;
  }

  /**
   * Return a snapshot of the queue for debugging.
   */
  getQueueSnapshot(): ReadonlyArray<Readonly<QueuedMessage>> {
    return [...this.queue];
  }

  // -- connectivity monitoring ----------------------------------------------

  /**
   * Begin monitoring network connectivity.
   *
   * Attempts to use React Native's NetInfo module if available, falling
   * back to a polling-based approach using fetch.
   */
  private startConnectivityMonitoring(): void {
    // Try to use @react-native-community/netinfo if available.
    try {
      // Dynamic require to avoid hard crash if not installed.
      const NetInfo = require('@react-native-community/netinfo');
      if (NetInfo && typeof NetInfo.addEventListener === 'function') {
        this.netInfoUnsubscribe = NetInfo.addEventListener(
          (state: { isConnected: boolean | null; isInternetReachable: boolean | null }) => {
            const wasOnline = this.connectivity === 'online';
            const nowOnline =
              state.isConnected === true &&
              state.isInternetReachable !== false;

            this.connectivity = nowOnline ? 'online' : 'offline';

            if (!wasOnline && nowOnline) {
              this.handleConnectivityRestored();
            } else if (wasOnline && !nowOnline) {
              this.handleConnectivityLost();
            }
          },
        );
        return;
      }
    } catch {
      // NetInfo not available -- fall through to polling.
    }

    // Fallback: poll connectivity by attempting a lightweight fetch.
    this.connectivityTimer = setInterval(() => {
      this.pollConnectivity();
    }, CONNECTIVITY_POLL_INTERVAL_MS);

    // Run an initial check immediately.
    this.pollConnectivity();
  }

  /**
   * Stop connectivity monitoring.
   */
  private stopConnectivityMonitoring(): void {
    if (this.netInfoUnsubscribe) {
      this.netInfoUnsubscribe();
      this.netInfoUnsubscribe = null;
    }

    if (this.connectivityTimer !== null) {
      clearInterval(this.connectivityTimer);
      this.connectivityTimer = null;
    }
  }

  /**
   * Poll connectivity by attempting to fetch a lightweight resource.
   */
  private async pollConnectivity(): Promise<void> {
    const wasOnline = this.connectivity === 'online';
    let nowOnline = false;

    try {
      // Attempt a HEAD request to a reliable, lightweight endpoint.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);

      const response = await fetch('https://www.gstatic.com/generate_204', {
        method: 'HEAD',
        signal: controller.signal,
        cache: 'no-store',
      });
      clearTimeout(timeout);
      nowOnline = response.ok || response.status === 204;
    } catch {
      nowOnline = false;
    }

    this.connectivity = nowOnline ? 'online' : 'offline';

    if (!wasOnline && nowOnline) {
      this.handleConnectivityRestored();
    } else if (wasOnline && !nowOnline) {
      this.handleConnectivityLost();
    }
  }

  /**
   * Handle the transition from offline to online.
   */
  private handleConnectivityRestored(): void {
    this.goOnline().catch(() => {
      // Relay connection failed; will retry on next connectivity event.
    });
  }

  /**
   * Handle the transition from online to offline.
   */
  private handleConnectivityLost(): void {
    // Unsubscribe from DMs since we can't receive them offline.
    if (this.dmSubscriptionId) {
      nostrClient.unsubscribe(this.dmSubscriptionId);
      this.dmSubscriptionId = null;
    }
  }

  // -- relay connection and subscription ------------------------------------

  /**
   * Connect to relays and set up the incoming DM subscription.
   */
  private async goOnline(): Promise<void> {
    // Start the relay manager (connects to best relays).
    await relayManager.start();

    // Subscribe for incoming gift-wrapped DMs addressed to us.
    this.subscribeToDMs();

    // Flush any queued messages.
    const flushed = await this.flushQueue();
    if (flushed > 0) {
      // Messages were delivered from the queue.
    }
  }

  /**
   * Subscribe to kind 1059 (gift wrap) events tagged with our pubkey.
   */
  private subscribeToDMs(): void {
    // Remove existing subscription if any.
    if (this.dmSubscriptionId) {
      nostrClient.unsubscribe(this.dmSubscriptionId);
      this.dmSubscriptionId = null;
    }

    if (!nostrClient.isConnected()) {
      return;
    }

    const filters: Filter[] = [
      {
        kinds: [KIND_GIFT_WRAP],
        '#p': [this.pubkey],
        // Only fetch events from the last 7 days to avoid overwhelming
        // the client on first connect.
        since: Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60,
      },
    ];

    this.dmSubscriptionId = nostrClient.subscribe(
      filters,
      (event: NostrEvent) => {
        this.handleIncomingEvent(event);
      },
    );
  }

  /**
   * Handle an incoming Nostr event (expected to be a kind 1059 gift wrap).
   */
  private handleIncomingEvent(event: NostrEvent): void {
    // De-duplicate: skip if we've already processed this event.
    if (this.seenEventIds.has(event.id)) {
      return;
    }
    this.markSeen(event.id);

    // Attempt to unwrap the gift-wrapped DM.
    const unwrapped = EventBuilder.unwrapGiftWrap(event, this.privkey);
    if (!unwrapped) {
      // Not a valid DM for us -- ignore.
      return;
    }

    // Notify all registered callbacks.
    for (const callback of this.messageCallbacks) {
      try {
        callback(unwrapped.senderPubkey, unwrapped.content, unwrapped.timestamp);
      } catch {
        // Consumer errors should not crash the bridge.
      }
    }
  }

  // -- queue management -----------------------------------------------------

  /**
   * Add a message to the outbound queue.
   *
   * @returns true if the message was queued, false if the queue is full.
   */
  private enqueue(recipientPubkey: string, content: string): boolean {
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      // Drop the oldest message to make room.
      this.queue.shift();
    }

    this.queue.push({
      recipientPubkey,
      content,
      queuedAt: Date.now(),
      attempts: 0,
    });

    return true;
  }

  // -- de-duplication -------------------------------------------------------

  /**
   * Mark an event ID as seen, evicting old entries if necessary.
   */
  private markSeen(eventId: string): void {
    this.seenEventIds.add(eventId);
    this.seenEventIdOrder.push(eventId);

    // Evict oldest entries when the set exceeds the maximum size.
    while (this.seenEventIdOrder.length > SEEN_EVENT_IDS_MAX) {
      const oldest = this.seenEventIdOrder.shift();
      if (oldest) {
        this.seenEventIds.delete(oldest);
      }
    }
  }

  // -- guards ---------------------------------------------------------------

  /**
   * Throw if the bridge has not been initialised.
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        'NostrBridge is not initialized. Call initialize() first.',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

const nostrBridge = new NostrBridge();
export default nostrBridge;
