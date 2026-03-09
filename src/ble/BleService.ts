/**
 * BleService.ts - High-level BLE API wrapping native modules
 *
 * Provides a clean TypeScript interface over the platform-specific BLE
 * native module (BleNativeModule) for GATT server/client operations used
 * by the Jisr mesh-chat protocol.
 *
 * GATT Service UUID : 0x4A53 ("JS" - Jisr Service)
 * TX Characteristic : 0x4A54 (write)
 * RX Characteristic : 0x4A52 (notify)
 * PEER_ID Char.     : 0x4A50 (read)
 */

import { NativeModules, NativeEventEmitter, Platform } from 'react-native';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 16-bit UUIDs expanded to full 128-bit Bluetooth Base UUID format. */
export const SERVICE_UUID = '00004a53-0000-1000-8000-00805f9b34fb';
export const TX_CHARACTERISTIC_UUID = '00004a54-0000-1000-8000-00805f9b34fb';
export const RX_CHARACTERISTIC_UUID = '00004a52-0000-1000-8000-00805f9b34fb';
export const PEER_ID_CHARACTERISTIC_UUID = '00004a50-0000-1000-8000-00805f9b34fb';

/** Default negotiated MTU. 185 bytes total - 3 bytes ATT header = 182 usable. */
export const DEFAULT_MTU = 185;
export const ATT_HEADER_SIZE = 3;
export const DEFAULT_USABLE_MTU = DEFAULT_MTU - ATT_HEADER_SIZE;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BleConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected';

export interface BlePeerEvent {
  peerId: string;
  displayName: string;
  rssi: number;
}

export interface BleDataEvent {
  peerId: string;
  /** Base-64 encoded data from the native side. */
  data: string;
}

export interface BleConnectionEvent {
  peerId: string;
  state: BleConnectionState;
}

export interface BleMtuEvent {
  peerId: string;
  mtu: number;
}

/** Shape of the native module exposed via the bridge. */
interface BleNativeModuleInterface {
  initialize(): Promise<void>;
  startScanning(serviceUuid: string): Promise<void>;
  stopScanning(): Promise<void>;
  startAdvertising(serviceUuid: string, localName: string): Promise<void>;
  stopAdvertising(): Promise<void>;
  connectToPeripheral(peripheralId: string, serviceUuid: string): Promise<void>;
  disconnectPeripheral(peripheralId: string): Promise<void>;
  writeCharacteristic(
    peripheralId: string,
    serviceUuid: string,
    characteristicUuid: string,
    data: string, // base64
  ): Promise<void>;
  readCharacteristic(
    peripheralId: string,
    serviceUuid: string,
    characteristicUuid: string,
  ): Promise<string>; // base64
  requestMtu(peripheralId: string, mtu: number): Promise<number>;
  getConnectedPeripherals(serviceUuid: string): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Native module reference
// ---------------------------------------------------------------------------

const { BleNativeModule } = NativeModules as {
  BleNativeModule: BleNativeModuleInterface;
};

if (!BleNativeModule) {
  throw new Error(
    'BleNativeModule is not linked. ' +
      'Make sure the native BLE module is properly installed and linked.',
  );
}

const bleEmitter = new NativeEventEmitter(
  // NativeEventEmitter requires the module on iOS; Android can pass null
  // but we pass the module for both platforms for safety.
  BleNativeModule as any,
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Encode a Uint8Array to a base-64 string for the native bridge. */
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return globalThis.btoa(binary);
}

/** Decode a base-64 string from the native bridge to Uint8Array. */
function base64ToUint8(b64: string): Uint8Array {
  const binary = globalThis.atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// BleService
// ---------------------------------------------------------------------------

export type BleEventUnsubscribe = () => void;

/**
 * High-level BLE service that manages scanning, advertising, connections,
 * and data transfer over the Jisr GATT service.
 *
 * This is a singleton -- import it and call the methods directly.
 */
class BleService {
  // -- state ----------------------------------------------------------------

  private _isInitialized = false;
  private _isScanning = false;
  private _isAdvertising = false;

  /**
   * Negotiated MTU per peer. Falls back to DEFAULT_USABLE_MTU if no
   * negotiation has occurred for a given peer.
   */
  private _peerMtu: Map<string, number> = new Map();

  // -- public state getters -------------------------------------------------

  get isInitialized(): boolean {
    return this._isInitialized;
  }

  get isScanning(): boolean {
    return this._isScanning;
  }

  get isAdvertising(): boolean {
    return this._isAdvertising;
  }

  // -- lifecycle ------------------------------------------------------------

  /**
   * Initialize the BLE stack. Must be called once before any other method.
   * Resolves when the native stack is ready.
   */
  async initialize(): Promise<void> {
    if (this._isInitialized) {
      return;
    }
    await BleNativeModule.initialize();
    this._isInitialized = true;
  }

  // -- scanning -------------------------------------------------------------

  /**
   * Start scanning for peripherals advertising the Jisr service UUID.
   * Discovered peripherals fire the `onPeerDiscovered` event.
   */
  async startScanning(): Promise<void> {
    this.ensureInitialized();
    if (this._isScanning) {
      return;
    }
    await BleNativeModule.startScanning(SERVICE_UUID);
    this._isScanning = true;
  }

  /** Stop an active BLE scan. */
  async stopScanning(): Promise<void> {
    if (!this._isScanning) {
      return;
    }
    await BleNativeModule.stopScanning();
    this._isScanning = false;
  }

  // -- advertising ----------------------------------------------------------

  /**
   * Start advertising this device as a Jisr peripheral so other devices
   * can discover and connect to it.
   *
   * @param localName  A human-readable name included in the advertisement.
   */
  async startAdvertising(localName: string = 'Jisr'): Promise<void> {
    this.ensureInitialized();
    if (this._isAdvertising) {
      return;
    }
    await BleNativeModule.startAdvertising(SERVICE_UUID, localName);
    this._isAdvertising = true;
  }

  /** Stop advertising. */
  async stopAdvertising(): Promise<void> {
    if (!this._isAdvertising) {
      return;
    }
    await BleNativeModule.stopAdvertising();
    this._isAdvertising = false;
  }

  // -- connections ----------------------------------------------------------

  /**
   * Connect to a discovered peer by its peripheral identifier.
   * After connection, an MTU negotiation is attempted automatically.
   */
  async connectToPeer(peerId: string): Promise<void> {
    this.ensureInitialized();
    await BleNativeModule.connectToPeripheral(peerId, SERVICE_UUID);

    // Attempt MTU negotiation (Android only -- iOS negotiates automatically).
    if (Platform.OS === 'android') {
      try {
        const negotiatedMtu = await BleNativeModule.requestMtu(
          peerId,
          DEFAULT_MTU,
        );
        this._peerMtu.set(peerId, negotiatedMtu - ATT_HEADER_SIZE);
      } catch {
        // Negotiation can fail on some devices; fall back to default.
        this._peerMtu.set(peerId, DEFAULT_USABLE_MTU);
      }
    } else {
      // iOS typically supports larger MTUs but we stay conservative.
      this._peerMtu.set(peerId, DEFAULT_USABLE_MTU);
    }
  }

  /** Disconnect from a connected peer. */
  async disconnectPeer(peerId: string): Promise<void> {
    await BleNativeModule.disconnectPeripheral(peerId);
    this._peerMtu.delete(peerId);
  }

  // -- data transfer --------------------------------------------------------

  /**
   * Send raw data to a connected peer by writing to the TX characteristic.
   *
   * If `data` exceeds the negotiated MTU the caller is responsible for
   * chunking at a higher level (see BleTransport). This method sends a
   * single write for the provided data.
   *
   * @throws If the data exceeds the usable MTU for this peer.
   */
  async sendData(peerId: string, data: Uint8Array): Promise<void> {
    this.ensureInitialized();
    const usableMtu = this.getUsableMtu(peerId);
    if (data.length > usableMtu) {
      throw new Error(
        `Data length ${data.length} exceeds usable MTU ${usableMtu} for peer ${peerId}. ` +
          'Use BleTransport for automatic fragmentation.',
      );
    }
    const b64 = uint8ToBase64(data);
    await BleNativeModule.writeCharacteristic(
      peerId,
      SERVICE_UUID,
      TX_CHARACTERISTIC_UUID,
      b64,
    );
  }

  /**
   * Read the PEER_ID characteristic from a connected peripheral to learn
   * its stable peer identity.
   */
  async readPeerId(peripheralId: string): Promise<string> {
    this.ensureInitialized();
    const b64 = await BleNativeModule.readCharacteristic(
      peripheralId,
      SERVICE_UUID,
      PEER_ID_CHARACTERISTIC_UUID,
    );
    const bytes = base64ToUint8(b64);
    return new TextDecoder().decode(bytes);
  }

  // -- connected peers ------------------------------------------------------

  /**
   * Return the list of peripheral identifiers currently connected and
   * advertising the Jisr service.
   */
  async getConnectedPeers(): Promise<string[]> {
    this.ensureInitialized();
    return BleNativeModule.getConnectedPeripherals(SERVICE_UUID);
  }

  // -- MTU helpers ----------------------------------------------------------

  /**
   * Return the usable (payload) MTU for a given peer.
   * If no negotiation has taken place, returns the conservative default.
   */
  getUsableMtu(peerId: string): number {
    return this._peerMtu.get(peerId) ?? DEFAULT_USABLE_MTU;
  }

  // -- events ---------------------------------------------------------------

  /**
   * Subscribe to peer discovery events.
   * Fires when a peripheral advertising the Jisr service is found.
   */
  onPeerDiscovered(callback: (event: BlePeerEvent) => void): BleEventUnsubscribe {
    const subscription = bleEmitter.addListener(
      'BleNative_PeerDiscovered',
      callback,
    );
    return () => subscription.remove();
  }

  /**
   * Subscribe to peer lost events.
   * Fires when a previously discovered peripheral is no longer visible.
   */
  onPeerLost(callback: (event: { peerId: string }) => void): BleEventUnsubscribe {
    const subscription = bleEmitter.addListener(
      'BleNative_PeerLost',
      callback,
    );
    return () => subscription.remove();
  }

  /**
   * Subscribe to incoming data events (notifications on the RX characteristic).
   * The `data` field is base-64 encoded from the native side and is decoded
   * to a Uint8Array before being passed to the callback.
   */
  onDataReceived(
    callback: (peerId: string, data: Uint8Array) => void,
  ): BleEventUnsubscribe {
    const subscription = bleEmitter.addListener(
      'BleNative_DataReceived',
      (event: BleDataEvent) => {
        callback(event.peerId, base64ToUint8(event.data));
      },
    );
    return () => subscription.remove();
  }

  /**
   * Subscribe to connection state changes for any peer.
   */
  onConnectionStateChanged(
    callback: (event: BleConnectionEvent) => void,
  ): BleEventUnsubscribe {
    const subscription = bleEmitter.addListener(
      'BleNative_ConnectionStateChanged',
      callback,
    );
    return () => subscription.remove();
  }

  /**
   * Subscribe to MTU change events (e.g. remote-initiated MTU exchange).
   */
  onMtuChanged(
    callback: (event: BleMtuEvent) => void,
  ): BleEventUnsubscribe {
    const subscription = bleEmitter.addListener(
      'BleNative_MtuChanged',
      (event: BleMtuEvent) => {
        this._peerMtu.set(event.peerId, event.mtu - ATT_HEADER_SIZE);
        callback(event);
      },
    );
    return () => subscription.remove();
  }

  // -- internals ------------------------------------------------------------

  private ensureInitialized(): void {
    if (!this._isInitialized) {
      throw new Error(
        'BleService is not initialized. Call initialize() first.',
      );
    }
  }
}

/** Singleton instance. */
const bleService = new BleService();
export default bleService;
