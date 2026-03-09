package com.jisr.ble

import android.bluetooth.BluetoothGatt
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.util.concurrent.ConcurrentHashMap

/**
 * BleConnectionPool - Multi-peer BLE connection management.
 *
 * Tracks active [BluetoothGatt] connections, enforces the Android practical
 * limit of 7 simultaneous connections, provides LRU eviction when the pool
 * is full, and implements auto-reconnect with exponential backoff for
 * unexpected disconnections.
 */
class BleConnectionPool(
    private val maxConnections: Int = MAX_CONNECTIONS,
    private val onReconnectRequested: ((address: String) -> Unit)? = null,
    private val onConnectionEvicted: ((address: String) -> Unit)? = null,
) {

    companion object {
        private const val TAG = "BleConnectionPool"

        /** Practical upper limit for simultaneous BLE connections on Android. */
        const val MAX_CONNECTIONS = 7

        /** Initial backoff delay for auto-reconnect (ms). */
        private const val INITIAL_BACKOFF_MS = 1_000L

        /** Maximum backoff delay for auto-reconnect (ms). */
        private const val MAX_BACKOFF_MS = 30_000L

        /** Backoff multiplier per retry. */
        private const val BACKOFF_MULTIPLIER = 2.0

        /** Maximum number of reconnect attempts before giving up. */
        private const val MAX_RECONNECT_ATTEMPTS = 5

        /** Time (ms) after which a CONNECTING state is considered stale. */
        private const val STALE_CONNECTION_TIMEOUT_MS = 30_000L
    }

    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    enum class ConnectionState {
        DISCONNECTED,
        CONNECTING,
        CONNECTED,
        DISCONNECTING
    }

    data class ConnectionEntry(
        val address: String,
        val peerId: String?,
        var gatt: BluetoothGatt?,
        var state: ConnectionState,
        var negotiatedMtu: Int = 23,
        var lastActivityTimestamp: Long = System.currentTimeMillis(),
        var reconnectAttempts: Int = 0,
        var nextReconnectDelay: Long = INITIAL_BACKOFF_MS,
        var shouldAutoReconnect: Boolean = true,
    )

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    /** All tracked connections, keyed by Bluetooth MAC address. */
    private val connections = ConcurrentHashMap<String, ConnectionEntry>()

    /** Ordered list of addresses for LRU eviction (most-recently-used at end). */
    private val lruOrder = mutableListOf<String>()

    private val handler = Handler(Looper.getMainLooper())

    /** Pending reconnect runnables keyed by address, for cancellation. */
    private val pendingReconnects = ConcurrentHashMap<String, Runnable>()

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Register a new connection or update an existing one.
     *
     * If the pool is at capacity and the connection is new, the least-recently
     * used connection is evicted first.
     *
     * @param address  Bluetooth MAC address.
     * @param peerId   Stable peer identity (may be null until PEER_ID is read).
     * @param gatt     The [BluetoothGatt] instance (null if not yet connected).
     * @param state    Initial connection state.
     * @return The [ConnectionEntry] that was added or updated.
     */
    @Synchronized
    fun addConnection(
        address: String,
        peerId: String? = null,
        gatt: BluetoothGatt? = null,
        state: ConnectionState = ConnectionState.CONNECTING,
    ): ConnectionEntry {
        cancelPendingReconnect(address)

        val existing = connections[address]
        if (existing != null) {
            existing.gatt = gatt ?: existing.gatt
            existing.state = state
            existing.lastActivityTimestamp = System.currentTimeMillis()
            if (peerId != null) {
                // ConnectionEntry is a data class so we need to replace it
                // to update the peerId (val). Instead we keep it mutable via
                // a separate update.
            }
            touchLru(address)
            Log.d(TAG, "Updated connection for $address -> $state")
            return existing
        }

        // Evict if at capacity.
        if (connections.size >= maxConnections) {
            evictLru()
        }

        val entry = ConnectionEntry(
            address = address,
            peerId = peerId,
            gatt = gatt,
            state = state,
        )
        connections[address] = entry
        lruOrder.add(address)
        Log.d(TAG, "Added connection for $address ($peerId) -> $state")
        return entry
    }

    /**
     * Remove a connection from the pool and close the underlying GATT client.
     */
    @Synchronized
    fun removeConnection(address: String) {
        cancelPendingReconnect(address)
        val entry = connections.remove(address)
        lruOrder.remove(address)
        entry?.let {
            try {
                it.gatt?.close()
            } catch (e: Exception) {
                Log.w(TAG, "Error closing GATT for $address", e)
            }
        }
        Log.d(TAG, "Removed connection for $address")
    }

    /**
     * Retrieve the connection entry for a given Bluetooth address.
     */
    fun getConnection(address: String): ConnectionEntry? {
        return connections[address]
    }

    /**
     * Retrieve the connection entry for a given peer ID (stable identity).
     */
    fun getConnectionByPeerId(peerId: String): ConnectionEntry? {
        return connections.values.firstOrNull { it.peerId == peerId }
    }

    /**
     * Return a list of all peer IDs that are currently in the CONNECTED state.
     */
    fun getConnectedPeers(): List<ConnectionEntry> {
        return connections.values.filter { it.state == ConnectionState.CONNECTED }
    }

    /**
     * Return all tracked connections regardless of state.
     */
    fun getAllConnections(): List<ConnectionEntry> {
        return connections.values.toList()
    }

    /**
     * Update the connection state for a given address.
     */
    @Synchronized
    fun updateState(address: String, state: ConnectionState) {
        val entry = connections[address] ?: return
        entry.state = state
        entry.lastActivityTimestamp = System.currentTimeMillis()
        touchLru(address)
        Log.d(TAG, "State updated for $address -> $state")
    }

    /**
     * Record the negotiated MTU for a connection.
     */
    fun updateMtu(address: String, mtu: Int) {
        connections[address]?.negotiatedMtu = mtu
    }

    /**
     * Update the stable peer ID for a connection (after reading PEER_ID
     * characteristic).
     */
    @Synchronized
    fun updatePeerId(address: String, peerId: String) {
        val existing = connections[address] ?: return
        // Since peerId is a val in the data class, we replace the entry.
        connections[address] = existing.copy(peerId = peerId)
    }

    /**
     * Mark a connection's last activity timestamp (e.g., on data exchange).
     */
    fun touch(address: String) {
        val entry = connections[address] ?: return
        entry.lastActivityTimestamp = System.currentTimeMillis()
        touchLru(address)
    }

    /**
     * Handle an unexpected disconnection for a peer. If auto-reconnect is
     * enabled and the retry limit has not been reached, schedules a reconnect
     * with exponential backoff.
     */
    @Synchronized
    fun handleUnexpectedDisconnect(address: String) {
        val entry = connections[address] ?: return
        if (!entry.shouldAutoReconnect) {
            Log.d(TAG, "Auto-reconnect disabled for $address, removing.")
            removeConnection(address)
            return
        }

        if (entry.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            Log.w(TAG, "Max reconnect attempts reached for $address, giving up.")
            removeConnection(address)
            return
        }

        entry.state = ConnectionState.DISCONNECTED
        entry.reconnectAttempts++
        val delay = entry.nextReconnectDelay
        entry.nextReconnectDelay = (delay * BACKOFF_MULTIPLIER).toLong()
            .coerceAtMost(MAX_BACKOFF_MS)

        Log.d(TAG, "Scheduling reconnect for $address in ${delay}ms " +
                "(attempt ${entry.reconnectAttempts}/$MAX_RECONNECT_ATTEMPTS)")

        val runnable = Runnable {
            pendingReconnects.remove(address)
            onReconnectRequested?.invoke(address)
        }
        pendingReconnects[address] = runnable
        handler.postDelayed(runnable, delay)
    }

    /**
     * Reset the reconnect backoff for a connection (call after a successful
     * reconnection).
     */
    fun resetReconnectBackoff(address: String) {
        val entry = connections[address] ?: return
        entry.reconnectAttempts = 0
        entry.nextReconnectDelay = INITIAL_BACKOFF_MS
    }

    /**
     * Disable auto-reconnect for a specific address (e.g., when the user
     * explicitly requests a disconnect).
     */
    fun disableAutoReconnect(address: String) {
        connections[address]?.shouldAutoReconnect = false
        cancelPendingReconnect(address)
    }

    /**
     * Clean up connections that have been stuck in CONNECTING state for too
     * long.
     */
    @Synchronized
    fun cleanupStaleConnections() {
        val now = System.currentTimeMillis()
        val stale = connections.entries.filter { (_, entry) ->
            entry.state == ConnectionState.CONNECTING &&
                    (now - entry.lastActivityTimestamp) > STALE_CONNECTION_TIMEOUT_MS
        }
        for ((address, _) in stale) {
            Log.w(TAG, "Cleaning up stale CONNECTING entry for $address")
            removeConnection(address)
        }
    }

    /**
     * Release all connections and cancel pending operations. Call during
     * teardown.
     */
    @Synchronized
    fun releaseAll() {
        for ((address, _) in pendingReconnects) {
            cancelPendingReconnect(address)
        }
        for ((_, entry) in connections) {
            try {
                entry.gatt?.close()
            } catch (e: Exception) {
                Log.w(TAG, "Error closing GATT during releaseAll", e)
            }
        }
        connections.clear()
        lruOrder.clear()
        Log.d(TAG, "All connections released.")
    }

    /**
     * Return the number of active (non-DISCONNECTED) connections.
     */
    fun activeCount(): Int {
        return connections.values.count { it.state != ConnectionState.DISCONNECTED }
    }

    /**
     * Check if the pool has room for another connection.
     */
    fun hasCapacity(): Boolean {
        return activeCount() < maxConnections
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    /** Move an address to the end (most-recently-used) of the LRU list. */
    private fun touchLru(address: String) {
        lruOrder.remove(address)
        lruOrder.add(address)
    }

    /**
     * Evict the least-recently-used connection to make room. Prefers to evict
     * DISCONNECTED entries first, then the oldest CONNECTED entry.
     */
    private fun evictLru() {
        // Prefer evicting disconnected entries.
        val disconnected = lruOrder.firstOrNull {
            connections[it]?.state == ConnectionState.DISCONNECTED
        }
        val target = disconnected ?: lruOrder.firstOrNull()

        if (target != null) {
            Log.w(TAG, "Evicting LRU connection: $target")
            val entry = connections[target]
            removeConnection(target)
            onConnectionEvicted?.invoke(target)
            // Close the evicted GATT (removeConnection already does this).
        }
    }

    /** Cancel a pending reconnect runnable for a given address. */
    private fun cancelPendingReconnect(address: String) {
        pendingReconnects.remove(address)?.let {
            handler.removeCallbacks(it)
            Log.d(TAG, "Cancelled pending reconnect for $address")
        }
    }
}
