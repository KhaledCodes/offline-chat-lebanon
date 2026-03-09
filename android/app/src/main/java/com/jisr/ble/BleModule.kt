package com.jisr.ble

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.util.Base64
import android.util.Log
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * BleModule - React Native native module bridging the Jisr BLE mesh layer.
 *
 * Exposes scanning, advertising, connection, and data-transfer APIs to the
 * JavaScript layer. Internally delegates to [BleCentralManager] (scanning /
 * central GATT client) and [BlePeripheralManager] (advertising / GATT server).
 *
 * All BLE operations are dispatched on the main thread (Android BLE
 * requirement) and results are communicated back to JS via React Native
 * events.
 *
 * ## Events emitted to JavaScript
 *
 * | Event name              | Payload                                  |
 * |-------------------------|------------------------------------------|
 * | onPeerDiscovered        | { peerId, name, rssi }                   |
 * | onPeerLost              | { peerId }                               |
 * | onDataReceived          | { peerId, data (base64) }                |
 * | onConnectionStateChanged| { peerId, state }                        |
 * | onBleStateChanged       | { state }                                |
 */
class BleModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext),
    LifecycleEventListener {

    companion object {
        private const val TAG = "BleModule"
        const val MODULE_NAME = "BleNativeModule"
    }

    // -------------------------------------------------------------------------
    // React Native module identity
    // -------------------------------------------------------------------------

    override fun getName(): String = MODULE_NAME

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    private var bluetoothManager: BluetoothManager? = null
    private var centralManager: BleCentralManager? = null
    private var peripheralManager: BlePeripheralManager? = null
    private var connectionPool: BleConnectionPool? = null
    private var isInitialized = false

    /**
     * Maps Bluetooth MAC addresses to stable peer IDs. Populated when the
     * PEER_ID characteristic is read from a peripheral, or when a peripheral
     * writes to our GATT server and we already know its address.
     */
    private val addressToPeerId = mutableMapOf<String, String>()
    private val peerIdToAddress = mutableMapOf<String, String>()

    /** BroadcastReceiver for Bluetooth adapter state changes. */
    private var bluetoothStateReceiver: BroadcastReceiver? = null

    // -------------------------------------------------------------------------
    // Initialization
    // -------------------------------------------------------------------------

    init {
        reactContext.addLifecycleEventListener(this)
    }

    /**
     * Initialize the BLE stack. Must be called from JS before any other
     * method. Sets up the BluetoothManager, connection pool, central manager,
     * and peripheral manager.
     */
    @ReactMethod
    fun initialize(promise: Promise) {
        if (isInitialized) {
            promise.resolve(null)
            return
        }

        val context = reactApplicationContext

        val btManager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        if (btManager == null) {
            promise.reject("BLE_UNAVAILABLE", "BluetoothManager is not available on this device.")
            return
        }

        bluetoothManager = btManager

        val adapter = btManager.adapter
        if (adapter == null) {
            promise.reject("BLE_UNAVAILABLE", "Bluetooth is not supported on this device.")
            return
        }

        // Connection pool with auto-reconnect support.
        val pool = BleConnectionPool(
            onReconnectRequested = { address ->
                Log.d(TAG, "Auto-reconnect requested for $address")
                centralManager?.connectToDevice(address)
            },
            onConnectionEvicted = { address ->
                Log.d(TAG, "Connection evicted for $address")
                val peerId = addressToPeerId[address]
                if (peerId != null) {
                    emitConnectionStateChanged(peerId, "disconnected")
                }
            }
        )
        connectionPool = pool

        // Central manager (scanning + GATT client).
        centralManager = BleCentralManager(
            context = context,
            bluetoothManager = btManager,
            connectionPool = pool,
            onPeerDiscovered = { address, name, rssi ->
                // We may not yet know the peer ID (address != peerId).
                // Emit with address as a temporary peerId; the JS side
                // will update once PEER_ID is read.
                val peerId = addressToPeerId[address] ?: address
                emitPeerDiscovered(peerId, name, rssi)
            },
            onPeerIdentified = { address, peerId ->
                addressToPeerId[address] = peerId
                peerIdToAddress[peerId] = address
                // Re-emit discovery now that we have the stable peerId.
                emitPeerDiscovered(peerId, null, 0)
            },
            onDataReceived = { address, data ->
                val peerId = addressToPeerId[address] ?: address
                emitDataReceived(peerId, data)
            },
            onConnectionStateChanged = { address, state ->
                val peerId = addressToPeerId[address] ?: address
                val stateStr = when (state) {
                    BleConnectionPool.ConnectionState.CONNECTED -> "connected"
                    BleConnectionPool.ConnectionState.CONNECTING -> "connecting"
                    BleConnectionPool.ConnectionState.DISCONNECTING -> "disconnecting"
                    BleConnectionPool.ConnectionState.DISCONNECTED -> "disconnected"
                }
                emitConnectionStateChanged(peerId, stateStr)
            },
            onMtuChanged = { address, mtu ->
                Log.d(TAG, "MTU changed for $address: $mtu")
            }
        )

        // Peripheral manager (advertising + GATT server).
        peripheralManager = BlePeripheralManager(
            context = context,
            bluetoothManager = btManager,
            onDataReceived = { deviceAddress, data ->
                val peerId = addressToPeerId[deviceAddress] ?: deviceAddress
                emitDataReceived(peerId, data)
            },
            onDeviceConnected = { deviceAddress ->
                Log.d(TAG, "Peripheral: device connected: $deviceAddress")
            },
            onDeviceDisconnected = { deviceAddress ->
                Log.d(TAG, "Peripheral: device disconnected: $deviceAddress")
            }
        )

        // Register for Bluetooth adapter state changes.
        registerBluetoothStateReceiver()

        // Emit current BLE state.
        val currentState = if (adapter.isEnabled) "poweredOn" else "poweredOff"
        emitBleStateChanged(currentState)

        isInitialized = true
        Log.d(TAG, "BLE module initialized.")
        promise.resolve(null)
    }

    // -------------------------------------------------------------------------
    // Scanning
    // -------------------------------------------------------------------------

    @ReactMethod
    fun startScanning(promise: Promise) {
        ensureInitialized(promise) ?: return

        try {
            centralManager?.startScanning()
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("SCAN_ERROR", "Failed to start scanning: ${e.message}", e)
        }
    }

    @ReactMethod
    fun stopScanning(promise: Promise) {
        ensureInitialized(promise) ?: return

        try {
            centralManager?.stopScanning()
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("SCAN_ERROR", "Failed to stop scanning: ${e.message}", e)
        }
    }

    // -------------------------------------------------------------------------
    // Advertising
    // -------------------------------------------------------------------------

    @ReactMethod
    fun startAdvertising(peerId: String, promise: Promise) {
        ensureInitialized(promise) ?: return

        try {
            peripheralManager?.startAdvertising(peerId)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("ADVERTISE_ERROR", "Failed to start advertising: ${e.message}", e)
        }
    }

    @ReactMethod
    fun stopAdvertising(promise: Promise) {
        ensureInitialized(promise) ?: return

        try {
            peripheralManager?.stopAdvertising()
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("ADVERTISE_ERROR", "Failed to stop advertising: ${e.message}", e)
        }
    }

    // -------------------------------------------------------------------------
    // Connections
    // -------------------------------------------------------------------------

    @ReactMethod
    fun connectToPeer(address: String, promise: Promise) {
        ensureInitialized(promise) ?: return

        // Resolve peerId -> address if needed (JS might pass either).
        val resolvedAddress = peerIdToAddress[address] ?: address

        try {
            centralManager?.connectToDevice(resolvedAddress)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("CONNECT_ERROR", "Failed to connect to $address: ${e.message}", e)
        }
    }

    @ReactMethod
    fun disconnectPeer(address: String) {
        if (!isInitialized) return

        val resolvedAddress = peerIdToAddress[address] ?: address

        try {
            centralManager?.disconnectDevice(resolvedAddress)
        } catch (e: Exception) {
            Log.e(TAG, "Error disconnecting from $address", e)
        }
    }

    // -------------------------------------------------------------------------
    // Data transfer
    // -------------------------------------------------------------------------

    @ReactMethod
    fun sendData(address: String, dataBase64: String, promise: Promise) {
        ensureInitialized(promise) ?: return

        val resolvedAddress = peerIdToAddress[address] ?: address

        try {
            val data = Base64.decode(dataBase64, Base64.NO_WRAP)

            // Try writing via central manager (GATT client to remote server).
            val sentViaCentral = centralManager?.writeData(resolvedAddress, data) ?: false

            if (sentViaCentral) {
                promise.resolve(null)
                return
            }

            // Fallback: try sending via peripheral manager (notification from
            // our GATT server to a connected central).
            val sentViaPeripheral = peripheralManager?.sendNotification(resolvedAddress, data) ?: false

            if (sentViaPeripheral) {
                promise.resolve(null)
                return
            }

            promise.reject(
                "SEND_ERROR",
                "Failed to send data to $address: peer is not connected via " +
                        "either central or peripheral role."
            )
        } catch (e: IllegalArgumentException) {
            promise.reject("SEND_ERROR", "Invalid base64 data: ${e.message}", e)
        } catch (e: Exception) {
            promise.reject("SEND_ERROR", "Failed to send data to $address: ${e.message}", e)
        }
    }

    // -------------------------------------------------------------------------
    // Lifecycle callbacks
    // -------------------------------------------------------------------------

    override fun onHostResume() {
        centralManager?.setForeground(true)
        connectionPool?.cleanupStaleConnections()
    }

    override fun onHostPause() {
        centralManager?.setForeground(false)
    }

    override fun onHostDestroy() {
        cleanup()
    }

    // -------------------------------------------------------------------------
    // Cleanup
    // -------------------------------------------------------------------------

    /**
     * Called by React Native when the Catalyst instance is being destroyed.
     */
    override fun invalidate() {
        cleanup()
        super.invalidate()
    }

    private fun cleanup() {
        try {
            centralManager?.stopScanning()
            centralManager?.release()
            peripheralManager?.stopAdvertising()
            connectionPool?.releaseAll()
            unregisterBluetoothStateReceiver()
        } catch (e: Exception) {
            Log.w(TAG, "Error during cleanup", e)
        }

        centralManager = null
        peripheralManager = null
        connectionPool = null
        bluetoothManager = null
        addressToPeerId.clear()
        peerIdToAddress.clear()
        isInitialized = false

        Log.d(TAG, "BLE module cleaned up.")
    }

    // -------------------------------------------------------------------------
    // Event emission helpers
    // -------------------------------------------------------------------------

    private fun emitPeerDiscovered(peerId: String, name: String?, rssi: Int) {
        val params = Arguments.createMap().apply {
            putString("peerId", peerId)
            putString("name", name ?: "")
            putInt("rssi", rssi)
        }
        sendEvent("onPeerDiscovered", params)
    }

    private fun emitPeerLost(peerId: String) {
        val params = Arguments.createMap().apply {
            putString("peerId", peerId)
        }
        sendEvent("onPeerLost", params)
    }

    private fun emitDataReceived(peerId: String, data: ByteArray) {
        val params = Arguments.createMap().apply {
            putString("peerId", peerId)
            putString("data", Base64.encodeToString(data, Base64.NO_WRAP))
        }
        sendEvent("onDataReceived", params)
    }

    private fun emitConnectionStateChanged(peerId: String, state: String) {
        val params = Arguments.createMap().apply {
            putString("peerId", peerId)
            putString("state", state)
        }
        sendEvent("onConnectionStateChanged", params)
    }

    private fun emitBleStateChanged(state: String) {
        val params = Arguments.createMap().apply {
            putString("state", state)
        }
        sendEvent("onBleStateChanged", params)
    }

    private fun sendEvent(eventName: String, params: WritableMap) {
        try {
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                ?.emit(eventName, params)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to emit event $eventName: ${e.message}")
        }
    }

    /**
     * Required by React Native to avoid warnings about unregistered event
     * listeners.
     */
    @ReactMethod
    fun addListener(eventName: String) {
        // No-op: required by React Native's NativeEventEmitter
    }

    @ReactMethod
    fun removeListeners(count: Int) {
        // No-op: required by React Native's NativeEventEmitter
    }

    // -------------------------------------------------------------------------
    // Bluetooth state receiver
    // -------------------------------------------------------------------------

    private fun registerBluetoothStateReceiver() {
        bluetoothStateReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                if (intent.action == BluetoothAdapter.ACTION_STATE_CHANGED) {
                    val state = intent.getIntExtra(
                        BluetoothAdapter.EXTRA_STATE,
                        BluetoothAdapter.ERROR
                    )
                    val stateStr = when (state) {
                        BluetoothAdapter.STATE_OFF -> "poweredOff"
                        BluetoothAdapter.STATE_TURNING_ON -> "turningOn"
                        BluetoothAdapter.STATE_ON -> "poweredOn"
                        BluetoothAdapter.STATE_TURNING_OFF -> "turningOff"
                        else -> "unknown"
                    }
                    emitBleStateChanged(stateStr)

                    // Auto-cleanup on Bluetooth disable.
                    if (state == BluetoothAdapter.STATE_OFF) {
                        centralManager?.stopScanning()
                        peripheralManager?.stopAdvertising()
                    }
                }
            }
        }

        val filter = IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            reactApplicationContext.registerReceiver(
                bluetoothStateReceiver,
                filter,
                Context.RECEIVER_NOT_EXPORTED
            )
        } else {
            reactApplicationContext.registerReceiver(bluetoothStateReceiver, filter)
        }
    }

    private fun unregisterBluetoothStateReceiver() {
        bluetoothStateReceiver?.let {
            try {
                reactApplicationContext.unregisterReceiver(it)
            } catch (e: Exception) {
                Log.w(TAG, "Error unregistering Bluetooth state receiver", e)
            }
        }
        bluetoothStateReceiver = null
    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    /**
     * Guard that checks initialization and rejects the promise if the module
     * has not been initialized. Returns a non-null Unit on success so callers
     * can use `ensureInitialized(promise) ?: return`.
     */
    private fun ensureInitialized(promise: Promise): Unit? {
        if (!isInitialized) {
            promise.reject(
                "NOT_INITIALIZED",
                "BLE module is not initialized. Call initialize() first."
            )
            return null
        }
        return Unit
    }
}
