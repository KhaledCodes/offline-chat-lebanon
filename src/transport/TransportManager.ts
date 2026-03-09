/**
 * TransportManager.ts - Unified send API for Jisr BLE mesh chat.
 *
 * Provides a single `sendMessage` method that selects the best available
 * transport in priority order:
 *
 *   1. BLE Direct  -- recipient is a directly connected BLE peer
 *   2. Mesh Relay  -- recipient is reachable via multi-hop mesh flooding
 *   3. Nostr       -- internet is available; relay via Nostr network
 *   4. Queue       -- no transport available; persist for later delivery
 *
 * The manager also listens for incoming data on all transports and
 * dispatches to registered message-received callbacks.
 */

import bleService from '../ble/BleService';
import PeerDiscovery from '../ble/PeerDiscovery';
import { encode, PacketType, PROTOCOL_VERSION, generateMessageId, BROADCAST_DST } from '../mesh/MeshProtocol';
import type { MeshPacket } from '../mesh/MeshProtocol';
import transportQueue from './TransportQueue';
import type { QueuedMessage } from './TransportQueue';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TransportType = 'ble' | 'mesh' | 'nostr' | 'queued';

export interface SendResult {
  transport: TransportType;
  messageId: string;
}

export interface TransportStatus {
  ble: boolean;
  mesh: boolean;
  nostr: boolean;
}

type MessageReceivedCallback = (
  senderId: string,
  content: Uint8Array,
  transport: TransportType,
) => void;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default mesh TTL for flooded packets. */
const MESH_DEFAULT_TTL = 5;

/** Nostr relay URLs (configurable at build time or runtime). */
const NOSTR_RELAYS: string[] = [
  'wss://relay.damus.io',
  'wss://nos.lol',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Encode a hex string into a Uint8Array (for peer id prefix extraction).
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Encode a Uint8Array to a hex string.
 */
function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Extract a 4-byte prefix from a peer/contact id for use as src/dst in
 * mesh packets.  If the id is shorter than 8 hex chars, it is zero-padded.
 */
function idPrefix(id: string): Uint8Array {
  const cleaned = id.replace(/-/g, '').substring(0, 8).padEnd(8, '0');
  return hexToBytes(cleaned);
}

// ---------------------------------------------------------------------------
// TransportManager
// ---------------------------------------------------------------------------

class TransportManager {
  private _initialized = false;
  private _listeners: Set<MessageReceivedCallback> = new Set();
  private _bleUnsubscribe: (() => void) | null = null;
  private _nostrAvailable = false;
  private _localPeerId: string = '';

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Initialize all transport layers and set up listeners.
   *
   * Must be called once at app startup after Database and BLE service
   * are initialized.
   */
  async initialize(): Promise<void> {
    if (this._initialized) {
      return;
    }

    // Subscribe to incoming BLE data and dispatch to listeners.
    this._bleUnsubscribe = bleService.onDataReceived(
      (peerId: string, data: Uint8Array) => {
        this.handleIncomingData(peerId, data, 'ble');
      },
    );

    // Register the queue flush callback so queued messages are retried
    // when a transport becomes available.
    transportQueue.onFlush(async (msg: QueuedMessage) => {
      try {
        const result = await this.sendMessage(msg.recipientId, msg.content);
        // Only consider it flushed if it was actually sent (not re-queued).
        return result.transport !== 'queued';
      } catch {
        return false;
      }
    });

    // Check Nostr availability (best-effort).
    this.probeNostrConnectivity();

    this._initialized = true;
  }

  /**
   * Set the local peer identity (typically derived from the device's
   * Ed25519 public key).  Must be set before sending messages.
   */
  setLocalPeerId(peerId: string): void {
    this._localPeerId = peerId;
  }

  // -----------------------------------------------------------------------
  // Send
  // -----------------------------------------------------------------------

  /**
   * Send a message to a recipient using the best available transport.
   *
   * Priority order:
   *   1. BLE Direct  -- peer is directly connected
   *   2. Mesh Relay  -- at least one mesh peer exists for flooding
   *   3. Nostr       -- internet connectivity detected
   *   4. Queue       -- persist for later delivery
   *
   * @param recipientId  The recipient's stable peer identity.
   * @param content      Raw encrypted message bytes.
   * @returns            The transport used and the generated message id.
   */
  async sendMessage(
    recipientId: string,
    content: Uint8Array,
  ): Promise<SendResult> {
    const msgId = generateMessageId();
    const msgIdHex = bytesToHex(msgId);

    // --- 1. BLE Direct -------------------------------------------------------
    if (this.isDirectlyConnected(recipientId)) {
      try {
        await this.sendViaBle(recipientId, content, msgId);
        return { transport: 'ble', messageId: msgIdHex };
      } catch {
        // Fall through to next transport.
      }
    }

    // --- 2. Mesh Relay -------------------------------------------------------
    if (this.hasMeshPeers()) {
      try {
        await this.sendViaMesh(recipientId, content, msgId);
        return { transport: 'mesh', messageId: msgIdHex };
      } catch {
        // Fall through to next transport.
      }
    }

    // --- 3. Nostr ------------------------------------------------------------
    if (this._nostrAvailable) {
      try {
        await this.sendViaNostr(recipientId, content, msgId);
        return { transport: 'nostr', messageId: msgIdHex };
      } catch {
        // Fall through to queue.
      }
    }

    // --- 4. Queue for later delivery -----------------------------------------
    transportQueue.enqueue(recipientId, content, msgIdHex);
    return { transport: 'queued', messageId: msgIdHex };
  }

  // -----------------------------------------------------------------------
  // Receive
  // -----------------------------------------------------------------------

  /**
   * Register a callback for incoming messages from any transport.
   *
   * @param callback  Invoked with sender id, raw content, and transport type.
   * @returns         An unsubscribe function.
   */
  onMessageReceived(
    callback: MessageReceivedCallback,
  ): () => void {
    this._listeners.add(callback);
    return () => {
      this._listeners.delete(callback);
    };
  }

  // -----------------------------------------------------------------------
  // Transport status
  // -----------------------------------------------------------------------

  /**
   * Return the current availability of each transport layer.
   */
  getTransportStatus(): TransportStatus {
    return {
      ble: bleService.isInitialized && bleService.isScanning,
      mesh: this.hasMeshPeers(),
      nostr: this._nostrAvailable,
    };
  }

  // -----------------------------------------------------------------------
  // Teardown
  // -----------------------------------------------------------------------

  /**
   * Clean up subscriptions and internal state.
   */
  destroy(): void {
    if (this._bleUnsubscribe) {
      this._bleUnsubscribe();
      this._bleUnsubscribe = null;
    }
    this._listeners.clear();
    this._initialized = false;
  }

  // -----------------------------------------------------------------------
  // Internal: BLE direct
  // -----------------------------------------------------------------------

  private isDirectlyConnected(recipientId: string): boolean {
    const discovery = PeerDiscovery.getInstance();
    return discovery.isDirectlyReachable(recipientId);
  }

  /**
   * Send data directly to a connected BLE peer.
   */
  private async sendViaBle(
    recipientId: string,
    content: Uint8Array,
    msgId: Uint8Array,
  ): Promise<void> {
    const packet: MeshPacket = {
      version: PROTOCOL_VERSION,
      type: PacketType.MESSAGE,
      msgId,
      srcId: idPrefix(this._localPeerId),
      dstId: idPrefix(recipientId),
      ttl: 0,
      hopCount: 0,
      payload: content,
    };

    const encoded = encode(packet);
    await bleService.sendData(recipientId, encoded);
  }

  // -----------------------------------------------------------------------
  // Internal: Mesh relay
  // -----------------------------------------------------------------------

  private hasMeshPeers(): boolean {
    const discovery = PeerDiscovery.getInstance();
    return discovery.getActivePeers().length > 0;
  }

  /**
   * Flood a message to all connected mesh peers.  Each receiving peer
   * will re-broadcast if the TTL allows, eventually reaching the
   * intended recipient.
   */
  private async sendViaMesh(
    recipientId: string,
    content: Uint8Array,
    msgId: Uint8Array,
  ): Promise<void> {
    const packet: MeshPacket = {
      version: PROTOCOL_VERSION,
      type: PacketType.MESSAGE,
      msgId,
      srcId: idPrefix(this._localPeerId),
      dstId: idPrefix(recipientId),
      ttl: MESH_DEFAULT_TTL,
      hopCount: 0,
      payload: content,
    };

    const encoded = encode(packet);
    const discovery = PeerDiscovery.getInstance();
    const peers = discovery.getActivePeers();

    // Send to all active peers in parallel (flood).
    const sendPromises = peers.map(peer =>
      bleService.sendData(peer.peerId, encoded).catch(() => {
        // Individual peer failures during flood are non-fatal.
      }),
    );

    await Promise.all(sendPromises);
  }

  // -----------------------------------------------------------------------
  // Internal: Nostr relay
  // -----------------------------------------------------------------------

  /**
   * Best-effort probe for Nostr relay connectivity.
   *
   * This performs a simple WebSocket open/close against the first relay
   * to determine if the device has internet access.  The result is cached
   * and re-probed periodically.
   */
  private probeNostrConnectivity(): void {
    if (NOSTR_RELAYS.length === 0) {
      this._nostrAvailable = false;
      return;
    }

    try {
      const ws = new WebSocket(NOSTR_RELAYS[0]);

      ws.onopen = () => {
        this._nostrAvailable = true;
        ws.close();

        // When Nostr becomes available, attempt to flush the queue.
        this.flushQueue();
      };

      ws.onerror = () => {
        this._nostrAvailable = false;
      };

      // Re-probe after 60 seconds regardless.
      setTimeout(() => this.probeNostrConnectivity(), 60_000);
    } catch {
      this._nostrAvailable = false;
    }
  }

  /**
   * Send a message via a Nostr relay.
   *
   * This is a simplified implementation.  A full integration would use
   * NIP-04 or NIP-44 encrypted direct messages through `nostr-tools`.
   * Here we prepare the envelope and delegate to the Nostr relay.
   */
  private async sendViaNostr(
    recipientId: string,
    content: Uint8Array,
    _msgId: Uint8Array,
  ): Promise<void> {
    // Encode content as base64 for the Nostr event payload.
    let binary = '';
    for (let i = 0; i < content.length; i++) {
      binary += String.fromCharCode(content[i]);
    }
    const contentBase64 = globalThis.btoa(binary);

    return new Promise<void>((resolve, reject) => {
      const relay = NOSTR_RELAYS[0];
      if (!relay) {
        reject(new Error('No Nostr relays configured'));
        return;
      }

      const ws = new WebSocket(relay);
      let settled = false;

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          ws.close();
          reject(new Error('Nostr send timed out'));
        }
      }, 10_000);

      ws.onopen = () => {
        // Build a minimal Nostr event.  A production implementation would
        // use `nostr-tools` finalizeEvent() with proper signing.
        const event = {
          kind: 4, // Encrypted Direct Message (NIP-04)
          tags: [['p', recipientId]],
          content: contentBase64,
          created_at: Math.floor(Date.now() / 1000),
        };

        ws.send(JSON.stringify(['EVENT', event]));
      };

      ws.onmessage = (evt) => {
        if (!settled) {
          try {
            const response = JSON.parse(evt.data as string);
            // Nostr OK response: ["OK", event_id, true/false, message]
            if (Array.isArray(response) && response[0] === 'OK') {
              settled = true;
              clearTimeout(timeout);
              ws.close();
              if (response[2]) {
                resolve();
              } else {
                reject(new Error(`Nostr relay rejected: ${response[3] ?? 'unknown'}`));
              }
            }
          } catch {
            // Ignore parse errors on non-OK messages.
          }
        }
      };

      ws.onerror = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          this._nostrAvailable = false;
          reject(new Error('Nostr WebSocket error'));
        }
      };
    });
  }

  // -----------------------------------------------------------------------
  // Internal: Queue flush
  // -----------------------------------------------------------------------

  /**
   * Attempt to flush queued messages.  Called when a transport becomes
   * available (e.g. a BLE peer connects, or Nostr connectivity is detected).
   */
  private async flushQueue(): Promise<void> {
    try {
      await transportQueue.flush();
    } catch {
      // Flush failures are non-fatal; messages remain queued.
    }
  }

  // -----------------------------------------------------------------------
  // Internal: Incoming data dispatch
  // -----------------------------------------------------------------------

  /**
   * Handle raw incoming data from any transport.  Parse the mesh packet
   * header and dispatch the payload to registered listeners.
   */
  private handleIncomingData(
    peerId: string,
    data: Uint8Array,
    transport: TransportType,
  ): void {
    // Attempt to decode the mesh protocol header to extract senderId
    // and payload.  If decoding fails (e.g. raw data from a non-mesh
    // peer), fall back to using the BLE peerId as sender.
    let senderId = peerId;
    let payload = data;

    try {
      // Import decode dynamically to avoid circular dependency issues.
      // The decode function validates the packet structure.
      const { decode } = require('../mesh/MeshProtocol');
      const packet = decode(data);

      if (packet.type === PacketType.MESSAGE) {
        senderId = bytesToHex(packet.srcId);
        payload = packet.payload;

        // Check if this message is for us or needs to be relayed.
        const localPrefix = idPrefix(this._localPeerId);
        const dstHex = bytesToHex(packet.dstId);
        const localHex = bytesToHex(localPrefix);
        const broadcastHex = bytesToHex(BROADCAST_DST);

        const isForUs = dstHex === localHex || dstHex === broadcastHex;

        if (!isForUs && packet.ttl > 0) {
          // Relay: decrement TTL and re-flood to other peers.
          this.relayPacket(packet, peerId);
          return;
        }

        if (!isForUs) {
          // Not for us and TTL exhausted -- drop.
          return;
        }
      }
    } catch {
      // Not a valid mesh packet -- treat raw data as the payload.
    }

    // Dispatch to all registered listeners.
    for (const listener of this._listeners) {
      try {
        listener(senderId, payload, transport);
      } catch {
        // Swallow listener errors.
      }
    }
  }

  /**
   * Relay a mesh packet to all connected peers except the one it came from.
   */
  private relayPacket(packet: MeshPacket, excludePeerId: string): void {
    const relayed: MeshPacket = {
      ...packet,
      ttl: packet.ttl - 1,
      hopCount: packet.hopCount + 1,
    };

    const encoded = encode(relayed);
    const discovery = PeerDiscovery.getInstance();
    const peers = discovery.getActivePeers();

    for (const peer of peers) {
      if (peer.peerId !== excludePeerId) {
        bleService.sendData(peer.peerId, encoded).catch(() => {
          // Non-fatal: some peers may have disconnected.
        });
      }
    }
  }
}

/** Singleton instance. */
const transportManager = new TransportManager();
export default transportManager;
