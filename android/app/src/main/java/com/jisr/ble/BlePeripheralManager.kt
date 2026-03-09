package com.jisr.ble

import android.Manifest
import android.bluetooth.*
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.ParcelUuid
import android.util.Base64
import android.util.Log
import androidx.core.content.ContextCompat
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * BlePeripheralManager - BLE advertising and GATT server management.
 *
 * Operates the device in the BLE peripheral role: advertises the Jisr service
 * UUID so that scanning centrals can discover this device, and runs a GATT
 * server that exposes the TX, RX, and PEER_ID characteristics.
 *
 * Data flow (from the GATT server's perspective):
 * - Central writes to TX -> this device receives data (onCharacteristicWriteRequest)
 * - Server sends notification on RX -> central receives data
 * - Central reads PEER_ID -> returns this device's stable peer identity
 */
class BlePeripheralManager(
    private val context: Context,
    private val bluetoothManager: BluetoothManager,
    private val onDataReceived: (deviceAddress: String, data: ByteArray) -> Unit,
    private val onDeviceConnected: (deviceAddress: String) -> Unit,
    private val onDeviceDisconnected: (deviceAddress: String) -> Unit,
) {

    companion object {
        private const val TAG = "BlePeripheralManager"

        // GATT service and characteristic UUIDs
        val SERVICE_UUID: UUID = UUID.fromString("4A530000-0000-1000-8000-00805F9B34FB")
        val TX_CHARACTERISTIC_UUID: UUID = UUID.fromString("4A540000-0000-1000-8000-00805F9B34FB")
        val RX_CHARACTERISTIC_UUID: UUID = UUID.fromString("4A520000-0000-1000-8000-00805F9B34FB")
        val PEER_ID_CHARACTERISTIC_UUID: UUID = UUID.fromString("4A500000-0000-1000-8000-00805F9B34FB")

        /** Standard Client Characteristic Configuration Descriptor UUID. */
        val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
    }

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    private var advertiser: BluetoothLeAdvertiser? = null
    private var gattServer: BluetoothGattServer? = null
    private var isAdvertising = false
    private var localPeerId: String = ""

    /** Devices that have enabled notifications on the RX characteristic. */
    private val subscribedDevices = ConcurrentHashMap<String, BluetoothDevice>()

    /** All devices currently connected to this GATT server. */
    private val connectedDevices = ConcurrentHashMap<String, BluetoothDevice>()

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Start advertising the Jisr service UUID and open the GATT server.
     *
     * @param peerId The stable peer identity to serve via the PEER_ID
     *               characteristic.
     */
    fun startAdvertising(peerId: String) {
        if (isAdvertising) {
            Log.w(TAG, "Already advertising, ignoring startAdvertising call.")
            return
        }

        if (!hasAdvertisePermission()) {
            Log.e(TAG, "Missing BLUETOOTH_ADVERTISE permission.")
            return
        }

        localPeerId = peerId

        val adapter = bluetoothManager.adapter
        if (adapter == null || !adapter.isEnabled) {
            Log.e(TAG, "Bluetooth adapter is null or disabled.")
            return
        }

        advertiser = adapter.bluetoothLeAdvertiser
        if (advertiser == null) {
            Log.e(TAG, "BLE advertising is not supported on this device.")
            return
        }

        // Set up the GATT server first so it is ready before we advertise.
        setupGattServer()

        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
            .setConnectable(true)
            .setTimeout(0) // Advertise indefinitely
            .build()

        val data = AdvertiseData.Builder()
            .setIncludeDeviceName(false) // Device name is often too long for adv packet
            .setIncludeTxPowerLevel(false)
            .addServiceUuid(ParcelUuid(SERVICE_UUID))
            .build()

        // Scan response can include the device name for discovery UX.
        val scanResponse = AdvertiseData.Builder()
            .setIncludeDeviceName(true)
            .build()

        try {
            advertiser?.startAdvertising(settings, data, scanResponse, advertiseCallback)
            Log.d(TAG, "Advertising started for peerId=$peerId")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start advertising", e)
        }
    }

    /**
     * Stop advertising and close the GATT server.
     */
    fun stopAdvertising() {
        if (!isAdvertising && gattServer == null) {
            return
        }

        try {
            if (hasAdvertisePermission()) {
                advertiser?.stopAdvertising(advertiseCallback)
            }
        } catch (e: Exception) {
            Log.w(TAG, "Error stopping advertising", e)
        }
        isAdvertising = false

        try {
            gattServer?.close()
        } catch (e: Exception) {
            Log.w(TAG, "Error closing GATT server", e)
        }
        gattServer = null

        subscribedDevices.clear()
        connectedDevices.clear()
        Log.d(TAG, "Advertising stopped and GATT server closed.")
    }

    /**
     * Send data to a connected central device via a notification on the RX
     * characteristic.
     *
     * @param deviceAddress The Bluetooth MAC address of the target device.
     * @param data          Raw bytes to send.
     * @return true if the notification was enqueued, false otherwise.
     */
    fun sendNotification(deviceAddress: String, data: ByteArray): Boolean {
        val server = gattServer ?: run {
            Log.w(TAG, "GATT server not running, cannot send notification.")
            return false
        }

        val device = subscribedDevices[deviceAddress] ?: run {
            Log.w(TAG, "Device $deviceAddress has not subscribed to notifications.")
            return false
        }

        val service = server.getService(SERVICE_UUID) ?: run {
            Log.w(TAG, "Jisr service not found on GATT server.")
            return false
        }

        val rxCharacteristic = service.getCharacteristic(RX_CHARACTERISTIC_UUID) ?: run {
            Log.w(TAG, "RX characteristic not found.")
            return false
        }

        return try {
            if (!hasConnectPermission()) {
                Log.e(TAG, "Missing BLUETOOTH_CONNECT permission.")
                return false
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                // API 33+ uses the new notifyCharacteristicChanged signature
                val status = server.notifyCharacteristicChanged(
                    device,
                    rxCharacteristic,
                    false, // confirm = false for notifications (not indications)
                    data
                )
                status == BluetoothStatusCodes.SUCCESS
            } else {
                @Suppress("DEPRECATION")
                rxCharacteristic.value = data
                @Suppress("DEPRECATION")
                server.notifyCharacteristicChanged(device, rxCharacteristic, false)
            }
        } catch (e: SecurityException) {
            Log.e(TAG, "SecurityException sending notification", e)
            false
        } catch (e: Exception) {
            Log.e(TAG, "Error sending notification to $deviceAddress", e)
            false
        }
    }

    /**
     * Send data to all subscribed devices via RX notifications.
     */
    fun broadcastNotification(data: ByteArray) {
        for (address in subscribedDevices.keys) {
            sendNotification(address, data)
        }
    }

    /**
     * Return the set of device addresses currently connected to this GATT
     * server.
     */
    fun getConnectedDeviceAddresses(): Set<String> {
        return connectedDevices.keys.toSet()
    }

    /**
     * Check whether a specific device has subscribed to RX notifications.
     */
    fun isDeviceSubscribed(address: String): Boolean {
        return subscribedDevices.containsKey(address)
    }

    // -------------------------------------------------------------------------
    // GATT server setup
    // -------------------------------------------------------------------------

    private fun setupGattServer() {
        if (!hasConnectPermission()) {
            Log.e(TAG, "Missing BLUETOOTH_CONNECT permission for GATT server.")
            return
        }

        try {
            gattServer = bluetoothManager.openGattServer(context, gattServerCallback)
            if (gattServer == null) {
                Log.e(TAG, "Failed to open GATT server.")
                return
            }

            val service = BluetoothGattService(
                SERVICE_UUID,
                BluetoothGattService.SERVICE_TYPE_PRIMARY
            )

            // TX Characteristic - Central writes data to this device.
            // Write without response for low-latency mesh data transfer.
            val txCharacteristic = BluetoothGattCharacteristic(
                TX_CHARACTERISTIC_UUID,
                BluetoothGattCharacteristic.PROPERTY_WRITE or
                        BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
                BluetoothGattCharacteristic.PERMISSION_WRITE
            )

            // RX Characteristic - This device notifies centrals with data.
            val rxCharacteristic = BluetoothGattCharacteristic(
                RX_CHARACTERISTIC_UUID,
                BluetoothGattCharacteristic.PROPERTY_NOTIFY,
                0 // No direct permissions; access is through CCCD
            )
            // Add the Client Characteristic Configuration Descriptor (CCCD)
            // so centrals can enable/disable notifications.
            val cccd = BluetoothGattDescriptor(
                CCCD_UUID,
                BluetoothGattDescriptor.PERMISSION_READ or
                        BluetoothGattDescriptor.PERMISSION_WRITE
            )
            rxCharacteristic.addDescriptor(cccd)

            // PEER_ID Characteristic - Centrals read this to get the stable
            // peer identity of this device.
            val peerIdCharacteristic = BluetoothGattCharacteristic(
                PEER_ID_CHARACTERISTIC_UUID,
                BluetoothGattCharacteristic.PROPERTY_READ,
                BluetoothGattCharacteristic.PERMISSION_READ
            )

            service.addCharacteristic(txCharacteristic)
            service.addCharacteristic(rxCharacteristic)
            service.addCharacteristic(peerIdCharacteristic)

            val added = gattServer?.addService(service)
            if (added == true) {
                Log.d(TAG, "GATT service added successfully.")
            } else {
                Log.e(TAG, "Failed to add GATT service.")
            }
        } catch (e: SecurityException) {
            Log.e(TAG, "SecurityException setting up GATT server", e)
        } catch (e: Exception) {
            Log.e(TAG, "Error setting up GATT server", e)
        }
    }

    // -------------------------------------------------------------------------
    // Advertise callback
    // -------------------------------------------------------------------------

    private val advertiseCallback = object : AdvertiseCallback() {
        override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) {
            isAdvertising = true
            Log.d(TAG, "Advertising started successfully.")
        }

        override fun onStartFailure(errorCode: Int) {
            isAdvertising = false
            val reason = when (errorCode) {
                ADVERTISE_FAILED_DATA_TOO_LARGE -> "DATA_TOO_LARGE"
                ADVERTISE_FAILED_TOO_MANY_ADVERTISERS -> "TOO_MANY_ADVERTISERS"
                ADVERTISE_FAILED_ALREADY_STARTED -> "ALREADY_STARTED"
                ADVERTISE_FAILED_INTERNAL_ERROR -> "INTERNAL_ERROR"
                ADVERTISE_FAILED_FEATURE_UNSUPPORTED -> "FEATURE_UNSUPPORTED"
                else -> "UNKNOWN($errorCode)"
            }
            Log.e(TAG, "Advertising failed to start: $reason")
        }
    }

    // -------------------------------------------------------------------------
    // GATT server callback
    // -------------------------------------------------------------------------

    private val gattServerCallback = object : BluetoothGattServerCallback() {

        override fun onConnectionStateChange(
            device: BluetoothDevice,
            status: Int,
            newState: Int
        ) {
            if (!hasConnectPermission()) return

            try {
                val address = device.address
                when (newState) {
                    BluetoothProfile.STATE_CONNECTED -> {
                        Log.d(TAG, "Device connected to GATT server: $address")
                        connectedDevices[address] = device
                        onDeviceConnected(address)
                    }
                    BluetoothProfile.STATE_DISCONNECTED -> {
                        Log.d(TAG, "Device disconnected from GATT server: $address")
                        connectedDevices.remove(address)
                        subscribedDevices.remove(address)
                        onDeviceDisconnected(address)
                    }
                }
            } catch (e: SecurityException) {
                Log.e(TAG, "SecurityException in onConnectionStateChange", e)
            }
        }

        override fun onCharacteristicReadRequest(
            device: BluetoothDevice,
            requestId: Int,
            offset: Int,
            characteristic: BluetoothGattCharacteristic
        ) {
            if (!hasConnectPermission()) return

            try {
                when (characteristic.uuid) {
                    PEER_ID_CHARACTERISTIC_UUID -> {
                        val peerIdBytes = localPeerId.toByteArray(Charsets.UTF_8)
                        if (offset >= peerIdBytes.size) {
                            gattServer?.sendResponse(
                                device,
                                requestId,
                                BluetoothGatt.GATT_SUCCESS,
                                offset,
                                ByteArray(0)
                            )
                        } else {
                            val responseBytes = peerIdBytes.copyOfRange(offset, peerIdBytes.size)
                            gattServer?.sendResponse(
                                device,
                                requestId,
                                BluetoothGatt.GATT_SUCCESS,
                                offset,
                                responseBytes
                            )
                        }
                        Log.d(TAG, "PEER_ID read request from ${device.address}, offset=$offset")
                    }
                    else -> {
                        Log.w(TAG, "Read request for unknown characteristic: ${characteristic.uuid}")
                        gattServer?.sendResponse(
                            device,
                            requestId,
                            BluetoothGatt.GATT_READ_NOT_PERMITTED,
                            0,
                            null
                        )
                    }
                }
            } catch (e: SecurityException) {
                Log.e(TAG, "SecurityException in onCharacteristicReadRequest", e)
            }
        }

        override fun onCharacteristicWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            characteristic: BluetoothGattCharacteristic,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray?
        ) {
            if (!hasConnectPermission()) return

            try {
                when (characteristic.uuid) {
                    TX_CHARACTERISTIC_UUID -> {
                        if (value != null && value.isNotEmpty()) {
                            Log.d(TAG, "Data received from ${device.address}: ${value.size} bytes")
                            onDataReceived(device.address, value)
                        }

                        if (responseNeeded) {
                            gattServer?.sendResponse(
                                device,
                                requestId,
                                BluetoothGatt.GATT_SUCCESS,
                                0,
                                null
                            )
                        }
                    }
                    else -> {
                        Log.w(TAG, "Write request for unknown characteristic: ${characteristic.uuid}")
                        if (responseNeeded) {
                            gattServer?.sendResponse(
                                device,
                                requestId,
                                BluetoothGatt.GATT_WRITE_NOT_PERMITTED,
                                0,
                                null
                            )
                        }
                    }
                }
            } catch (e: SecurityException) {
                Log.e(TAG, "SecurityException in onCharacteristicWriteRequest", e)
            }
        }

        override fun onDescriptorReadRequest(
            device: BluetoothDevice,
            requestId: Int,
            offset: Int,
            descriptor: BluetoothGattDescriptor
        ) {
            if (!hasConnectPermission()) return

            try {
                if (descriptor.uuid == CCCD_UUID) {
                    val value = if (subscribedDevices.containsKey(device.address)) {
                        BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                    } else {
                        BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE
                    }
                    gattServer?.sendResponse(
                        device,
                        requestId,
                        BluetoothGatt.GATT_SUCCESS,
                        0,
                        value
                    )
                } else {
                    gattServer?.sendResponse(
                        device,
                        requestId,
                        BluetoothGatt.GATT_READ_NOT_PERMITTED,
                        0,
                        null
                    )
                }
            } catch (e: SecurityException) {
                Log.e(TAG, "SecurityException in onDescriptorReadRequest", e)
            }
        }

        override fun onDescriptorWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            descriptor: BluetoothGattDescriptor,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray?
        ) {
            if (!hasConnectPermission()) return

            try {
                if (descriptor.uuid == CCCD_UUID) {
                    if (value != null && value.contentEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)) {
                        Log.d(TAG, "Device ${device.address} subscribed to RX notifications.")
                        subscribedDevices[device.address] = device
                    } else if (value != null && value.contentEquals(BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE)) {
                        Log.d(TAG, "Device ${device.address} unsubscribed from RX notifications.")
                        subscribedDevices.remove(device.address)
                    }

                    if (responseNeeded) {
                        gattServer?.sendResponse(
                            device,
                            requestId,
                            BluetoothGatt.GATT_SUCCESS,
                            0,
                            null
                        )
                    }
                } else {
                    if (responseNeeded) {
                        gattServer?.sendResponse(
                            device,
                            requestId,
                            BluetoothGatt.GATT_WRITE_NOT_PERMITTED,
                            0,
                            null
                        )
                    }
                }
            } catch (e: SecurityException) {
                Log.e(TAG, "SecurityException in onDescriptorWriteRequest", e)
            }
        }

        override fun onMtuChanged(device: BluetoothDevice, mtu: Int) {
            Log.d(TAG, "MTU changed for ${device.address}: $mtu")
        }

        override fun onNotificationSent(device: BluetoothDevice, status: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                Log.w(TAG, "Notification send failed for ${device.address}, status=$status")
            }
        }
    }

    // -------------------------------------------------------------------------
    // Permission helpers
    // -------------------------------------------------------------------------

    private fun hasAdvertisePermission(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.BLUETOOTH_ADVERTISE
            ) == PackageManager.PERMISSION_GRANTED
        } else {
            true // Pre-S does not require this runtime permission
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
