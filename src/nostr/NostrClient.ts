/**
 * NostrClient.ts - WebSocket relay connection manager for Jisr.
 *
 * Manages connections to Nostr relays, implementing the NIP-01 protocol
 * for publishing events, subscribing to filters, and handling incoming
 * messages. Supports automatic reconnection with exponential backoff.
 *
 * NIP-01 message types handled:
 *   CLIENT -> RELAY : ["EVENT", <event>]
 *                     ["REQ",   <sub_id>, <filter>, ...]
 *                     ["CLOSE", <sub_id>]
 *   RELAY -> CLIENT : ["EVENT", <sub_id>, <event>]
 *                     ["OK",    <event_id>, <accepted>, <message>]
 *                     ["EOSE",  <sub_id>]
 *                     ["NOTICE", <message>]
 *                     ["CLOSED", <sub_id>, <message>]
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A signed Nostr event conforming to NIP-01. */
export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** A NIP-01 subscription filter. */
export interface Filter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  '#e'?: string[];
  '#p'?: string[];
}

/** Callback invoked when an event matching a subscription arrives. */
type EventCallback = (event: NostrEvent) => void;

/** Pending publish that waits for an OK response from the relay. */
interface PendingPublish {
  resolve: () => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Internal subscription record. */
interface Subscription {
  id: string;
  filters: Filter[];
  onEvent: EventCallback;
}

/** Per-relay connection state. */
interface RelayConnection {
  url: string;
  ws: WebSocket | null;
  connected: boolean;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  pendingPublishes: Map<string, PendingPublish>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Initial reconnect delay in milliseconds. */
const INITIAL_RECONNECT_DELAY_MS = 1_000;

/** Maximum reconnect delay in milliseconds. */
const MAX_RECONNECT_DELAY_MS = 30_000;

/** Timeout for waiting on an OK response after publishing. */
const PUBLISH_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// NostrClient
// ---------------------------------------------------------------------------

/**
 * WebSocket-based Nostr relay client.
 *
 * Maintains connections to one or more relays and multiplexes
 * subscriptions and publishes across all connected relays.
 */
class NostrClient {
  // -- state ----------------------------------------------------------------

  /** Active relay connections keyed by URL. */
  private relays: Map<string, RelayConnection> = new Map();

  /** Active subscriptions keyed by subscription ID. */
  private subscriptions: Map<string, Subscription> = new Map();

  /** Monotonically increasing counter for subscription IDs. */
  private subIdCounter = 0;

  /** Optional listener for NOTICE messages from relays. */
  private noticeListener: ((relayUrl: string, message: string) => void) | null =
    null;

  // -- public API -----------------------------------------------------------

  /**
   * Connect to a Nostr relay.
   *
   * Resolves once the WebSocket connection is established or rejects if
   * the initial connection attempt fails within a reasonable timeout.
   */
  connect(url: string): Promise<void> {
    // Normalise URL.
    const normalised = this.normaliseUrl(url);

    // If already connected or connecting, return immediately.
    const existing = this.relays.get(normalised);
    if (existing?.connected) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      this.createConnection(normalised, resolve, reject);
    });
  }

  /**
   * Disconnect from a relay and stop any reconnection attempts.
   */
  disconnect(url: string): void {
    const normalised = this.normaliseUrl(url);
    const relay = this.relays.get(normalised);
    if (!relay) {
      return;
    }

    // Prevent reconnection.
    relay.reconnectAttempts = -1;
    if (relay.reconnectTimer !== null) {
      clearTimeout(relay.reconnectTimer);
      relay.reconnectTimer = null;
    }

    // Reject all pending publishes.
    for (const [, pending] of relay.pendingPublishes) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Relay disconnected'));
    }
    relay.pendingPublishes.clear();

    // Close the socket.
    if (relay.ws) {
      try {
        relay.ws.close();
      } catch {
        // Ignore close errors.
      }
      relay.ws = null;
    }

    relay.connected = false;
    this.relays.delete(normalised);
  }

  /**
   * Disconnect from all relays.
   */
  disconnectAll(): void {
    const urls = Array.from(this.relays.keys());
    for (const url of urls) {
      this.disconnect(url);
    }
    this.subscriptions.clear();
  }

  /**
   * Publish a signed event to all connected relays.
   *
   * Resolves when at least one relay acknowledges with an OK response.
   * Rejects if no relay accepts the event within the timeout.
   */
  async publish(event: NostrEvent): Promise<void> {
    const connectedRelays = this.getConnectedRelayEntries();
    if (connectedRelays.length === 0) {
      throw new Error('No connected relays to publish to');
    }

    const message = JSON.stringify(['EVENT', event]);

    // Race: resolve as soon as any relay returns OK.
    const promises: Promise<void>[] = connectedRelays.map((relay) => {
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          relay.pendingPublishes.delete(event.id);
          reject(new Error(`Publish timeout on relay ${relay.url}`));
        }, PUBLISH_TIMEOUT_MS);

        relay.pendingPublishes.set(event.id, { resolve, reject, timer });

        try {
          relay.ws?.send(message);
        } catch (err) {
          clearTimeout(timer);
          relay.pendingPublishes.delete(event.id);
          reject(
            new Error(
              `Failed to send to ${relay.url}: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
        }
      });
    });

    // Settle when the first relay accepts.
    await Promise.any(promises).catch((aggErr) => {
      // If all relays rejected, throw a combined error.
      throw new Error(
        `All relays rejected publish: ${aggErr instanceof AggregateError ? aggErr.errors.map((e: Error) => e.message).join('; ') : String(aggErr)}`,
      );
    });
  }

  /**
   * Subscribe to events matching the given filters across all connected relays.
   *
   * @returns A subscription ID that can be passed to `unsubscribe()`.
   */
  subscribe(filters: Filter[], onEvent: EventCallback): string {
    const subId = this.nextSubId();
    const sub: Subscription = { id: subId, filters, onEvent };
    this.subscriptions.set(subId, sub);

    // Send REQ to all connected relays.
    const message = JSON.stringify(['REQ', subId, ...filters]);
    for (const relay of this.getConnectedRelayEntries()) {
      try {
        relay.ws?.send(message);
      } catch {
        // Will be retried on reconnect.
      }
    }

    return subId;
  }

  /**
   * Close a subscription on all relays.
   */
  unsubscribe(subId: string): void {
    if (!this.subscriptions.has(subId)) {
      return;
    }

    this.subscriptions.delete(subId);

    const message = JSON.stringify(['CLOSE', subId]);
    for (const relay of this.getConnectedRelayEntries()) {
      try {
        relay.ws?.send(message);
      } catch {
        // Best-effort.
      }
    }
  }

  /**
   * Returns true if at least one relay is connected.
   */
  isConnected(): boolean {
    for (const relay of this.relays.values()) {
      if (relay.connected) {
        return true;
      }
    }
    return false;
  }

  /**
   * Returns the URLs of all currently connected relays.
   */
  getConnectedRelays(): string[] {
    const result: string[] = [];
    for (const relay of this.relays.values()) {
      if (relay.connected) {
        result.push(relay.url);
      }
    }
    return result;
  }

  /**
   * Register a listener for NOTICE messages from relays.
   */
  onNotice(listener: (relayUrl: string, message: string) => void): void {
    this.noticeListener = listener;
  }

  // -- connection management ------------------------------------------------

  /**
   * Create a new WebSocket connection to a relay.
   *
   * @param url       Normalised relay URL.
   * @param onOpen    Callback for initial connection success (only used on first connect).
   * @param onFail    Callback for initial connection failure.
   */
  private createConnection(
    url: string,
    onOpen?: () => void,
    onFail?: (err: Error) => void,
  ): void {
    const relay: RelayConnection = this.relays.get(url) ?? {
      url,
      ws: null,
      connected: false,
      reconnectAttempts: 0,
      reconnectTimer: null,
      pendingPublishes: new Map(),
    };
    this.relays.set(url, relay);

    let initialCallbackFired = false;

    try {
      const ws = new WebSocket(url);
      relay.ws = ws;

      ws.onopen = () => {
        relay.connected = true;
        relay.reconnectAttempts = 0;

        // Re-subscribe all active subscriptions on this relay.
        this.resubscribeAll(relay);

        if (!initialCallbackFired) {
          initialCallbackFired = true;
          onOpen?.();
        }
      };

      ws.onmessage = (messageEvent: MessageEvent) => {
        this.handleMessage(relay, messageEvent);
      };

      ws.onerror = (_event: Event) => {
        // The close event will fire after this -- actual cleanup happens there.
        if (!initialCallbackFired) {
          initialCallbackFired = true;
          onFail?.(new Error(`WebSocket error connecting to ${url}`));
        }
      };

      ws.onclose = () => {
        const wasConnected = relay.connected;
        relay.connected = false;
        relay.ws = null;

        // Reject all pending publishes.
        for (const [, pending] of relay.pendingPublishes) {
          clearTimeout(pending.timer);
          pending.reject(new Error(`Connection to ${url} closed`));
        }
        relay.pendingPublishes.clear();

        if (!initialCallbackFired) {
          initialCallbackFired = true;
          onFail?.(new Error(`Connection to ${url} closed before opening`));
        }

        // Schedule reconnection if not intentionally disconnected.
        if (relay.reconnectAttempts >= 0 && wasConnected) {
          this.scheduleReconnect(relay);
        } else if (relay.reconnectAttempts >= 0) {
          // Connection failed on first attempt; still try to reconnect.
          this.scheduleReconnect(relay);
        }
      };
    } catch (err) {
      if (!initialCallbackFired) {
        initialCallbackFired = true;
        onFail?.(
          new Error(
            `Failed to create WebSocket for ${url}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    }
  }

  /**
   * Schedule a reconnection attempt with exponential backoff.
   *
   * Delays: 1s, 2s, 4s, 8s, 16s, 30s (capped).
   */
  private scheduleReconnect(relay: RelayConnection): void {
    // Guard: disconnect() sets reconnectAttempts to -1.
    if (relay.reconnectAttempts < 0) {
      return;
    }

    // Clear any existing reconnect timer.
    if (relay.reconnectTimer !== null) {
      clearTimeout(relay.reconnectTimer);
    }

    const delay = Math.min(
      INITIAL_RECONNECT_DELAY_MS * Math.pow(2, relay.reconnectAttempts),
      MAX_RECONNECT_DELAY_MS,
    );

    relay.reconnectAttempts += 1;

    relay.reconnectTimer = setTimeout(() => {
      relay.reconnectTimer = null;
      this.createConnection(relay.url);
    }, delay);
  }

  /**
   * Re-send all active subscriptions to a newly connected relay.
   */
  private resubscribeAll(relay: RelayConnection): void {
    for (const sub of this.subscriptions.values()) {
      const message = JSON.stringify(['REQ', sub.id, ...sub.filters]);
      try {
        relay.ws?.send(message);
      } catch {
        // Will be retried on next reconnect.
      }
    }
  }

  // -- message handling -----------------------------------------------------

  /**
   * Parse and dispatch an incoming relay message according to NIP-01.
   */
  private handleMessage(relay: RelayConnection, messageEvent: MessageEvent): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        typeof messageEvent.data === 'string'
          ? messageEvent.data
          : String(messageEvent.data),
      );
    } catch {
      // Malformed JSON -- ignore.
      return;
    }

    if (!Array.isArray(parsed) || parsed.length < 2) {
      return;
    }

    const type = parsed[0] as string;

    switch (type) {
      case 'EVENT':
        this.handleEvent(parsed);
        break;

      case 'OK':
        this.handleOk(relay, parsed);
        break;

      case 'EOSE':
        // End of stored events -- no action needed for now.
        // Subscriptions continue to receive new events after EOSE.
        break;

      case 'NOTICE':
        this.handleNotice(relay, parsed);
        break;

      case 'CLOSED':
        this.handleClosed(parsed);
        break;

      default:
        // Unknown message type -- ignore per NIP-01.
        break;
    }
  }

  /**
   * Handle an EVENT message: ["EVENT", <sub_id>, <event>].
   */
  private handleEvent(parsed: unknown[]): void {
    if (parsed.length < 3) {
      return;
    }

    const subId = parsed[1] as string;
    const eventData = parsed[2] as NostrEvent;

    if (!eventData || typeof eventData.id !== 'string') {
      return;
    }

    const sub = this.subscriptions.get(subId);
    if (sub) {
      try {
        sub.onEvent(eventData);
      } catch {
        // Consumer error should not crash the client.
      }
    }
  }

  /**
   * Handle an OK message: ["OK", <event_id>, <accepted: boolean>, <message>].
   */
  private handleOk(relay: RelayConnection, parsed: unknown[]): void {
    if (parsed.length < 3) {
      return;
    }

    const eventId = parsed[1] as string;
    const accepted = parsed[2] as boolean;
    const message = (parsed[3] as string) ?? '';

    const pending = relay.pendingPublishes.get(eventId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    relay.pendingPublishes.delete(eventId);

    if (accepted) {
      pending.resolve();
    } else {
      pending.reject(new Error(`Relay ${relay.url} rejected event: ${message}`));
    }
  }

  /**
   * Handle a NOTICE message: ["NOTICE", <message>].
   */
  private handleNotice(relay: RelayConnection, parsed: unknown[]): void {
    if (parsed.length < 2) {
      return;
    }
    const message = parsed[1] as string;
    this.noticeListener?.(relay.url, message);
  }

  /**
   * Handle a CLOSED message: ["CLOSED", <sub_id>, <message>].
   *
   * The relay is informing us that it has closed a subscription.
   */
  private handleClosed(parsed: unknown[]): void {
    if (parsed.length < 2) {
      return;
    }
    const subId = parsed[1] as string;
    // Remove the subscription from our local map since the relay closed it.
    this.subscriptions.delete(subId);
  }

  // -- helpers --------------------------------------------------------------

  /**
   * Return all relay entries that are currently connected.
   */
  private getConnectedRelayEntries(): RelayConnection[] {
    const result: RelayConnection[] = [];
    for (const relay of this.relays.values()) {
      if (relay.connected && relay.ws) {
        result.push(relay);
      }
    }
    return result;
  }

  /**
   * Generate a unique subscription ID.
   */
  private nextSubId(): string {
    this.subIdCounter += 1;
    return `jisr_sub_${this.subIdCounter}`;
  }

  /**
   * Normalise a relay URL (trim whitespace, ensure trailing-slash consistency).
   */
  private normaliseUrl(url: string): string {
    return url.trim().replace(/\/+$/, '');
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

const nostrClient = new NostrClient();
export default nostrClient;
