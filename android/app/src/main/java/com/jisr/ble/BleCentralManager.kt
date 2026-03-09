package com.jisr.ble

import android.Manifest
import android.bluetooth.*
import android.bluetooth.le.*
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.util.Base64
import android.util.Log
import androidx.core.content.ContextCompat
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * BleCentralManager - BLE scanning and GATT central-role operations.
 *
 * Responsible for:
 * - Scanning for peripherals advertising the Jisr service UUID
 * - Connecting to discovered peripherals as a GATT client
 * - Discovering services and reading the PEER_ID characteristic
 * - Enabling notifications on the RX characteristic
 * - Writing data to the TX characteristic
 * - MTU negotiation
 * - Managing multiple simultaneous connections
 */
class BleCentralManager(
    private val context: Context,
    private val bluetoothManager: BluetoothManager,
    private val connectionPool: BleConnectionPool,
    private val onPeerDiscovered: (address: String, name: String?, rssi: Int) -> Unit,
    private val onPeerIdentified: (address: String, peerId: String) -> Unit,
    private val onDataReceived: (address: String, data: ByteArray) -> Unit,
    private val onConnectionStateChanged: (address: String, state: BleConnectionPool.ConnectionState) -> Unit,
    private val onMtuChanged: (address: String, mtu: Int) -> Unit,
) {

    companion object {
        private const val TAG = "BleCentralManager"

        // GATT UUIDs (shared with BlePeripheralManager)
        val SERVICE_UUID: UUID = UUID.fromString("4A530000-0000-1000-8000-00805F9B34FB")
        val TX_CHARACTERISTIC_UUID: UUID = UUID.fromString("4A540000-0000-1000-8000-00805F9B34FB")
        val RX_CHARACTERISTIC_UUID: UUID = UUID.fromString("4A520000-0000-1000-8000-00805F9B34FB")
        val PEER_ID_CHARACTERISTIC_UUID: UUID = UUID.fromString("4A500000-0000-1000-8000-00805F9B34FB")
        val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

        /** Requested MTU size. Android supports up to 517; we request 512. */
        private const val REQUESTED_MTU = 512

        /** Scan restart interval to work around Android's 30-minute scan limit. */
        private const val SCAN_RESTART_INTERVAL_MS = 25 * 60 * 1000L // 25 minutes

        /** Delay before connecting after discovery to allow scan results to settle. */
        private const val CONNECTION_DELAY_MS = 100L
    }

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    private var scanner: BluetoothLeScanner? = null
    private var isScanning = false
    private var isInForeground = true

    private val handler = Handler(Looper.getMainLooper())

    /** Addresses discovered in the current scan cycle, to avoid duplicate connections. */
    private val discoveredAddresses = ConcurrentHashMap.newKeySet<String>()

    /** Pending GATT operation queues per device to serialize BLE operations. */
    private val gattOperationQueues = ConcurrentHashMap<String, ArrayDeque<() -> Unit>>()
    private val gattOperationInProgress = ConcurrentHashMap<String, Boolean>()

    /** Scan restart runnable for the 30-minute workaround. */
    private val scanRestartRunnable = Runnable {
        if (isScanning) {
            Log.d(TAG, "Restarting scan to avoid 30-minute Android limit.")
            stopScanInternal()
            handler.postDelayed({ startScanInternal() }, 500)
        }
    }

    // -------------------------------------------------------------------------
    // Public API: Scanning
    // -------------------------------------------------------------------------

    /**
     * Start scanning for peripherals advertising the Jisr service UUID.
     *
     * Uses LOW_LATENCY mode in foreground and LOW_POWER in background.
     */
    fun startScanning() {
        if (isScanning) {
            Log.d(TAG, "Already scanning.")
            return
        }

        if (!hasScanPermission()) {
            Log.e(TAG, "Missing BLUETOOTH_SCAN permission.")
            return
        }

        val adapter = bluetoothManager.adapter
        if (adapter == null || !adapter.isEnabled) {
            Log.e(TAG, "Bluetooth adapter is null or disabled.")
            return
        }

        scanner = adapter.bluetoothLeScanner
        if (scanner == null) {
            Log.e(TAG, "BluetoothLeScanner is not available.")
            return
        }

        discoveredAddresses.clear()
        startScanInternal()
    }

    /**
     * Stop scanning for peripherals.
     */
    fun stopScanning() {
        if (!isScanning) return
        handler.removeCallbacks(scanRestartRunnable)
        stopScanInternal()
    }

    /**
     * Notify the manager of foreground/background transitions so scan mode
     * can be adjusted.
     */
    fun setForeground(foreground: Boolean) {
        if (isInForeground == foreground) return
        isInForeground = foreground

        if (isScanning) {
            Log.d(TAG, "Foreground state changed to $foreground, restarting scan.")
            stopScanInternal()
            handler.postDelayed({ startScanInternal() }, 200)
        }
    }

    // -------------------------------------------------------------------------
    // Public API: Connections
    // -------------------------------------------------------------------------

    /**
     * Connect to a peripheral by its Bluetooth MAC address.
     *
     * The connection flow is:
     * 1. Connect GATT
     * 2. Discover services
     * 3. Request MTU
     * 4. Read PEER_ID characteristic
     * 5. Enable RX notifications
     */
    fun connectToDevice(address: String) {
        if (!hasConnectPermission()) {
            Log.e(TAG, "Missing BLUETOOTH_CONNECT permission.")
            return
        }

        val existing = connectionPool.getConnection(address)
        if (existing != null && (existing.state == BleConnectionPool.ConnectionState.CONNECTED ||
                    existing.state == BleConnectionPool.ConnectionState.CONNECTING)) {
            Log.d(TAG, "Already connected or connecting to $address.")
            return
        }

        if (!connectionPool.hasCapacity()) {
            Log.w(TAG, "Connection pool at capacity. Cannot connect to $address.")
            return
        }

        val adapter = bluetoothManager.adapter ?: run {
            Log.e(TAG, "Bluetooth adapter is null.")
            return
        }

        try {
            val device = adapter.getRemoteDevice(address)
            connectionPool.addConnection(
                address = address,
                state = BleConnectionPool.ConnectionState.CONNECTING
            )
            onConnectionStateChanged(address, BleConnectionPool.ConnectionState.CONNECTING)

            // Use TRANSPORT_LE explicitly to avoid classic Bluetooth fallback.
            val gatt = device.connectGatt(
                context,
                false, // autoConnect = false for faster initial connection
                gattCallback,
                BluetoothDevice.TRANSPORT_LE
            )

            if (gatt != null) {
                connectionPool.addConnection(
                    address = address,
                    gatt = gatt,
                    state = BleConnectionPool.ConnectionState.CONNECTING
                )
            } else {
                Log.e(TAG, "connectGatt returned null for $address")
                connectionPool.removeConnection(address)
                onConnectionStateChanged(address, BleConnectionPool.ConnectionState.DISCONNECTED)
            }
        } catch (e: SecurityException) {
            Log.e(TAG, "SecurityException connecting to $address", e)
            connectionPool.removeConnection(address)
            onConnectionStateChanged(address, BleConnectionPool.ConnectionState.DISCONNECTED)
        } catch (e: Exception) {
            Log.e(TAG, "Error connecting to $address", e)
            connectionPool.removeConnection(address)
            onConnectionStateChanged(address, BleConnectionPool.ConnectionState.DISCONNECTED)
        }
    }

    /**
     * Disconnect from a connected peripheral.
     */
    fun disconnectDevice(address: String) {
        if (!hasConnectPermission()) return

        connectionPool.disableAutoReconnect(address)
        val entry = connectionPool.getConnection(address) ?: return

        try {
            connectionPool.updateState(address, BleConnectionPool.ConnectionState.DISCONNECTING)
            entry.gatt?.disconnect()
            // GATT will be closed in the callback after disconnect completes.
        } catch (e: SecurityException) {
            Log.e(TAG, "SecurityException disconnecting from $address", e)
            connectionPool.removeConnection(address)
        }
    }

    /**
     * Write data to the TX characteristic of a connected peripheral.
     *
     * @param address The Bluetooth MAC address.
     * @param data    Raw bytes to send.
     * @return true if the write was enqueued, false on error.
     */
    fun writeData(address: String, data: ByteArray): Boolean {
        val entry = connectionPool.getConnection(address)
        if (entry == null || entry.state != BleConnectionPool.ConnectionState.CONNECTED) {
            Log.w(TAG, "Cannot write to $address: not connected.")
            return false
        }

        val gatt = entry.gatt ?: run {
            Log.w(TAG, "No GATT instance for $address.")
            return false
        }

        if (!hasConnectPermission()) {
            Log.e(TAG, "Missing BLUETOOTH_CONNECT permission.")
            return false
        }

        enqueueGattOperation(address) {
            try {
                val service = gatt.getService(SERVICE_UUID)
                if (service == null) {
                    Log.w(TAG, "Jisr service not found on $address.")
                    completeGattOperation(address)
                    return@enqueueGattOperation
                }

                val txChar = service.getCharacteristic(TX_CHARACTERISTIC_UUID)
                if (txChar == null) {
                    Log.w(TAG, "TX characteristic not found on $address.")
                    completeGattOperation(address)
                    return@enqueueGattOperation
                }

                val success = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    val result = gatt.writeCharacteristic(
                        txChar,
                        data,
                        BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
                    )
                    result == BluetoothStatusCodes.SUCCESS
                } else {
                    @Suppress("DEPRECATION")
                    txChar.value = data
                    @Suppress("DEPRECATION")
                    txChar.writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
                    @Suppress("DEPRECATION")
                    gatt.writeCharacteristic(txChar)
                }

                if (!success) {
                    Log.w(TAG, "writeCharacteristic failed for $address")
                    completeGattOperation(address)
                }
                // Success: completeGattOperation will be called in onCharacteristicWrite callback
            } catch (e: SecurityException) {
                Log.e(TAG, "SecurityException writing to $address", e)
                completeGattOperation(address)
            }
        }

        connectionPool.touch(address)
        return true
    }

    /**
     * Release all resources. Call during teardown.
     */
    fun release() {
        stopScanning()
        gattOperationQueues.clear()
        gattOperationInProgress.clear()
        discoveredAddresses.clear()
    }

    // -------------------------------------------------------------------------
    // Internal: Scanning
    // -------------------------------------------------------------------------

    private fun startScanInternal() {
        if (!hasScanPermission()) return

        try {
            val scanMode = if (isInForeground) {
                ScanSettings.SCAN_MODE_LOW_LATENCY
            } else {
                ScanSettings.SCAN_MODE_LOW_POWER
            }

            val settings = ScanSettings.Builder()
                .setScanMode(scanMode)
                .setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
                .setMatchMode(ScanSettings.MATCH_MODE_AGGRESSIVE)
                .setNumOfMatches(ScanSettings.MATCH_NUM_MAX_ADVERTISEMENT)
                .setReportDelay(0) // Immediate callback
                .build()

            val filter = ScanFilter.Builder()
                .setServiceUuid(ParcelUuid(SERVICE_UUID))
                .build()

            scanner?.startScan(listOf(filter), settings, scanCallback)
            isScanning = true
            Log.d(TAG, "Scan started (mode=${if (isInForeground) "LOW_LATENCY" else "LOW_POWER"})")

            // Schedule restart to avoid Android's 30-min scan timeout.
            handler.removeCallbacks(scanRestartRunnable)
            handler.postDelayed(scanRestartRunnable, SCAN_RESTART_INTERVAL_MS)
        } catch (e: SecurityException) {
            Log.e(TAG, "SecurityException starting scan", e)
            isScanning = false
        } catch (e: Exception) {
            Log.e(TAG, "Error starting scan", e)
            isScanning = false
        }
    }

    private fun stopScanInternal() {
        if (!hasScanPermission()) return

        try {
            scanner?.stopScan(scanCallback)
        } catch (e: SecurityException) {
            Log.w(TAG, "SecurityException stopping scan", e)
        } catch (e: Exception) {
            Log.w(TAG, "Error stopping scan", e)
        }
        isScanning = false
        Log.d(TAG, "Scan stopped.")
    }

    // -------------------------------------------------------------------------
    // Scan callback
    // -------------------------------------------------------------------------

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            if (!hasConnectPermission()) return

            try {
                val address = result.device.address
                val name = result.device.name ?: result.scanRecord?.deviceName
                val rssi = result.rssi

                // Emit discovery event for every scan result (JS side deduplicates
                // and uses it to update RSSI / lastSeen).
                onPeerDiscovered(address, name, rssi)

                // Track unique addresses for this scan cycle.
                discoveredAddresses.add(address)
            } catch (e: SecurityException) {
                Log.e(TAG, "SecurityException processing scan result", e)
            }
        }

        override fun onBatchScanResults(results: MutableList<ScanResult>) {
            for (result in results) {
                onScanResult(ScanSettings.CALLBACK_TYPE_ALL_MATCHES, result)
            }
        }

        override fun onScanFailed(errorCode: Int) {
            isScanning = false
            val reason = when (errorCode) {
                SCAN_FAILED_ALREADY_STARTED -> "ALREADY_STARTED"
                SCAN_FAILED_APPLICATION_REGISTRATION_FAILED -> "APP_REGISTRATION_FAILED"
                SCAN_FAILED_INTERNAL_ERROR -> "INTERNAL_ERROR"
                SCAN_FAILED_FEATURE_UNSUPPORTED -> "FEATURE_UNSUPPORTED"
                else -> "UNKNOWN($errorCode)"
            }
            Log.e(TAG, "Scan failed: $reason")
        }
    }

    // -------------------------------------------------------------------------
    // GATT callback
    // -------------------------------------------------------------------------

    private val gattCallback = object : BluetoothGattCallback() {

        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            if (!hasConnectPermission()) return

            val address = gatt.device.address

            try {
                when (newState) {
                    BluetoothProfile.STATE_CONNECTED -> {
                        Log.d(TAG, "Connected to $address (status=$status)")
                        connectionPool.addConnection(address, gatt = gatt,
                            state = BleConnectionPool.ConnectionState.CONNECTED)
                        connectionPool.resetReconnectBackoff(address)
                        onConnectionStateChanged(address, BleConnectionPool.ConnectionState.CONNECTED)

                        // Discover services after connection.
                        handler.postDelayed({
                            try {
                                if (hasConnectPermission()) {
                                    gatt.discoverServices()
                                }
                            } catch (e: SecurityException) {
                                Log.e(TAG, "SecurityException discovering services", e)
                            }
                        }, CONNECTION_DELAY_MS)
                    }

                    BluetoothProfile.STATE_DISCONNECTED -> {
                        Log.d(TAG, "Disconnected from $address (status=$status)")
                        val entry = connectionPool.getConnection(address)
                        val wasIntentional = entry?.state == BleConnectionPool.ConnectionState.DISCONNECTING

                        // Clean up GATT operation queue.
                        gattOperationQueues.remove(address)
                        gattOperationInProgress.remove(address)

                        if (wasIntentional) {
                            connectionPool.removeConnection(address)
                            onConnectionStateChanged(address, BleConnectionPool.ConnectionState.DISCONNECTED)
                        } else {
                            // Unexpected disconnect: attempt auto-reconnect.
                            try { gatt.close() } catch (_: Exception) {}
                            connectionPool.handleUnexpectedDisconnect(address)
                            onConnectionStateChanged(address, BleConnectionPool.ConnectionState.DISCONNECTED)
                        }
                    }
                }
            } catch (e: SecurityException) {
                Log.e(TAG, "SecurityException in onConnectionStateChange", e)
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            val address = gatt.device.address

            if (status != BluetoothGatt.GATT_SUCCESS) {
                Log.e(TAG, "Service discovery failed for $address (status=$status)")
                return
            }

            Log.d(TAG, "Services discovered for $address")

            val service = gatt.getService(SERVICE_UUID)
            if (service == null) {
                Log.w(TAG, "Jisr service not found on $address after discovery.")
                return
            }

            // Step 1: Request MTU negotiation.
            try {
                if (hasConnectPermission()) {
                    gatt.requestMtu(REQUESTED_MTU)
                }
            } catch (e: SecurityException) {
                Log.e(TAG, "SecurityException requesting MTU", e)
                // Continue with default MTU; proceed to read PEER_ID.
                readPeerIdCharacteristic(gatt, address)
            }
        }

        override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
            val address = gatt.device.address

            if (status == BluetoothGatt.GATT_SUCCESS) {
                Log.d(TAG, "MTU changed to $mtu for $address")
                connectionPool.updateMtu(address, mtu)
                onMtuChanged(address, mtu)
            } else {
                Log.w(TAG, "MTU change failed for $address (status=$status), using default.")
            }

            // Step 2: Read the PEER_ID characteristic.
            readPeerIdCharacteristic(gatt, address)
        }

        override fun onCharacteristicRead(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            status: Int
        ) {
            // Deprecated in API 33 but needed for backward compat
            val address = gatt.device.address
            completeGattOperation(address)

            if (status != BluetoothGatt.GATT_SUCCESS) {
                Log.w(TAG, "Characteristic read failed for $address (status=$status)")
                return
            }

            @Suppress("DEPRECATION")
            handleCharacteristicRead(address, characteristic.uuid, characteristic.value, gatt)
        }

        // API 33+ variant
        override fun onCharacteristicRead(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray,
            status: Int
        ) {
            val address = gatt.device.address
            completeGattOperation(address)

            if (status != BluetoothGatt.GATT_SUCCESS) {
                Log.w(TAG, "Characteristic read failed for $address (status=$status)")
                return
            }

            handleCharacteristicRead(address, characteristic.uuid, value, gatt)
        }

        override fun onCharacteristicWrite(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            status: Int
        ) {
            val address = gatt.device.address
            completeGattOperation(address)

            if (status != BluetoothGatt.GATT_SUCCESS) {
                Log.w(TAG, "Characteristic write failed for $address (status=$status)")
            }
        }

        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic
        ) {
            // Deprecated in API 33 but needed for backward compat
            @Suppress("DEPRECATION")
            val value = characteristic.value ?: return
            handleNotification(gatt.device.address, characteristic.uuid, value)
        }

        // API 33+ variant
        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray
        ) {
            handleNotification(gatt.device.address, characteristic.uuid, value)
        }

        override fun onDescriptorWrite(
            gatt: BluetoothGatt,
            descriptor: BluetoothGattDescriptor,
            status: Int
        ) {
            val address = gatt.device.address
            completeGattOperation(address)

            if (status == BluetoothGatt.GATT_SUCCESS) {
                Log.d(TAG, "Descriptor written for $address: ${descriptor.uuid}")
            } else {
                Log.w(TAG, "Descriptor write failed for $address (status=$status)")
            }
        }
    }

    // -------------------------------------------------------------------------
    // Internal: Characteristic handling
    // -------------------------------------------------------------------------

    private fun handleCharacteristicRead(
        address: String,
        uuid: UUID,
        value: ByteArray?,
        gatt: BluetoothGatt
    ) {
        when (uuid) {
            PEER_ID_CHARACTERISTIC_UUID -> {
                if (value != null && value.isNotEmpty()) {
                    val peerId = String(value, Charsets.UTF_8)
                    Log.d(TAG, "PEER_ID for $address: $peerId")
                    connectionPool.updatePeerId(address, peerId)
                    onPeerIdentified(address, peerId)

                    // Step 3: Enable notifications on RX characteristic.
                    enableRxNotifications(gatt, address)
                } else {
                    Log.w(TAG, "Empty PEER_ID from $address")
                }
            }
            else -> {
                Log.d(TAG, "Read characteristic $uuid from $address: ${value?.size ?: 0} bytes")
            }
        }
    }

    private fun handleNotification(address: String, uuid: UUID, value: ByteArray) {
        when (uuid) {
            RX_CHARACTERISTIC_UUID -> {
                Log.d(TAG, "RX notification from $address: ${value.size} bytes")
                connectionPool.touch(address)
                onDataReceived(address, value)
            }
            else -> {
                Log.d(TAG, "Notification from $address on $uuid: ${value.size} bytes")
            }
        }
    }

    // -------------------------------------------------------------------------
    // Internal: GATT operations post-discovery
    // -------------------------------------------------------------------------

    private fun readPeerIdCharacteristic(gatt: BluetoothGatt, address: String) {
        enqueueGattOperation(address) {
            try {
                if (!hasConnectPermission()) {
                    completeGattOperation(address)
                    return@enqueueGattOperation
                }

                val service = gatt.getService(SERVICE_UUID)
                val peerIdChar = service?.getCharacteristic(PEER_ID_CHARACTERISTIC_UUID)
                if (peerIdChar != null) {
                    val success = gatt.readCharacteristic(peerIdChar)
                    if (!success) {
                        Log.w(TAG, "readCharacteristic(PEER_ID) returned false for $address")
                        completeGattOperation(address)
                    }
                    // Success: completeGattOperation in onCharacteristicRead
                } else {
                    Log.w(TAG, "PEER_ID characteristic not found on $address")
                    completeGattOperation(address)
                    // Still try to enable notifications
                    enableRxNotifications(gatt, address)
                }
            } catch (e: SecurityException) {
                Log.e(TAG, "SecurityException reading PEER_ID", e)
                completeGattOperation(address)
            }
        }
    }

    private fun enableRxNotifications(gatt: BluetoothGatt, address: String) {
        enqueueGattOperation(address) {
            try {
                if (!hasConnectPermission()) {
                    completeGattOperation(address)
                    return@enqueueGattOperation
                }

                val service = gatt.getService(SERVICE_UUID)
                val rxChar = service?.getCharacteristic(RX_CHARACTERISTIC_UUID)

                if (rxChar == null) {
                    Log.w(TAG, "RX characteristic not found on $address")
                    completeGattOperation(address)
                    return@enqueueGattOperation
                }

                // Enable local notification reception
                val notifySuccess = gatt.setCharacteristicNotification(rxChar, true)
                if (!notifySuccess) {
                    Log.w(TAG, "setCharacteristicNotification failed for $address")
                    completeGattOperation(address)
                    return@enqueueGattOperation
                }

                // Write to the CCCD to tell the remote GATT server to start
                // sending notifications.
                val cccd = rxChar.getDescriptor(CCCD_UUID)
                if (cccd != null) {
                    val writeSuccess = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        val result = gatt.writeDescriptor(
                            cccd,
                            BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                        )
                        result == BluetoothStatusCodes.SUCCESS
                    } else {
                        @Suppress("DEPRECATION")
                        cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                        @Suppress("DEPRECATION")
                        gatt.writeDescriptor(cccd)
                    }

                    if (!writeSuccess) {
                        Log.w(TAG, "CCCD write failed for $address")
                        completeGattOperation(address)
                    }
                    // Success: completeGattOperation in onDescriptorWrite
                } else {
                    Log.w(TAG, "CCCD descriptor not found on RX characteristic for $address")
                    completeGattOperation(address)
                }
            } catch (e: SecurityException) {
                Log.e(TAG, "SecurityException enabling RX notifications", e)
                completeGattOperation(address)
            }
        }
    }

    // -------------------------------------------------------------------------
    // Internal: GATT operation queue
    // -------------------------------------------------------------------------

    /**
     * Android requires that only one GATT operation be in flight at a time per
     * device. This queue serializes operations.
     */
    private fun enqueueGattOperation(address: String, operation: () -> Unit) {
        val queue = gattOperationQueues.getOrPut(address) { ArrayDeque() }
        queue.addLast(operation)

        // If no operation is currently in progress, start this one.
        if (gattOperationInProgress[address] != true) {
            executeNextGattOperation(address)
        }
    }

    private fun executeNextGattOperation(address: String) {
        val queue = gattOperationQueues[address] ?: return
        val operation = queue.removeFirstOrNull()

        if (operation != null) {
            gattOperationInProgress[address] = true
            handler.post(operation)
        } else {
            gattOperationInProgress[address] = false
        }
    }

    private fun completeGattOperation(address: String) {
        gattOperationInProgress[address] = false
        // Small delay to allow the BLE stack to settle between operations.
        handler.postDelayed({
            executeNextGattOperation(address)
        }, 10)
    }

    // -------------------------------------------------------------------------
    // Permission helpers
    // -------------------------------------------------------------------------

    private fun hasScanPermission(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.BLUETOOTH_SCAN
            ) == PackageManager.PERMISSION_GRANTED
        } else {
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.ACCESS_FINE_LOCATION
            ) == PackageManager.PERMISSION_GRANTED
        }
    }

    private fun hasConnectPermission(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.BLUETOOTH_CONNECT
            ) == PackageManager.PERMISSION_GRANTED
        } else {
            true
        }
    }
}
