//
//  StateRestorationHandler.swift
//  Jisr
//
//  Handles iOS CoreBluetooth state restoration for background BLE operation.
//
//  When iOS terminates the app to reclaim memory, CoreBluetooth can relaunch it
//  to handle BLE events. The restoration identifiers allow the system to restore
//  the CBCentralManager and CBPeripheralManager state, including any peripherals
//  that were connected or pending connection.
//
//  Data received during restoration (before the React Native bridge is ready)
//  is queued and delivered once the JS side subscribes.
//

import Foundation
import CoreBluetooth

// MARK: - Constants

/// State restoration identifier for the central manager.
let kCentralRestorationIdentifier = "com.jisr.ble.central"

/// State restoration identifier for the peripheral manager.
let kPeripheralRestorationIdentifier = "com.jisr.ble.peripheral"

// MARK: - Queued Event

/// Represents a BLE event received during state restoration before the
/// React Native bridge was ready to receive it.
enum QueuedBleEvent {
    /// Data received from a peer (base64-encoded payload and peer identifier).
    case dataReceived(peerId: String, data: String)
    /// A peer's connection state changed.
    case connectionStateChanged(peerId: String, state: String)
    /// A peer was discovered during restoration.
    case peerDiscovered(peerId: String, name: String, rssi: NSNumber)
}

// MARK: - StateRestorationHandler

/// Singleton that manages BLE state restoration and event queuing.
///
/// During state restoration, CoreBluetooth may deliver events before the
/// React Native bridge is initialized. This handler queues those events
/// and flushes them once the bridge signals readiness.
final class StateRestorationHandler {

    // MARK: Singleton

    static let shared = StateRestorationHandler()
    private init() {}

    // MARK: Properties

    /// Thread-safe queue for events received before the bridge is ready.
    private let queue = DispatchQueue(label: "com.jisr.ble.restoration.queue")

    /// Events accumulated during restoration.
    private var pendingEvents: [QueuedBleEvent] = []

    /// Whether the React Native bridge has signaled readiness.
    private var isBridgeReady = false

    /// Callback invoked for each flushed event. Set by BleModule once the
    /// bridge is ready.
    var eventHandler: ((QueuedBleEvent) -> Void)?

    // MARK: - Peripherals Awaiting Re-subscription

    /// Peripherals that were restored and need characteristic re-subscription.
    /// Keyed by peripheral identifier UUID string.
    private var restoredPeripherals: [String: CBPeripheral] = [:]

    // MARK: - Event Queuing

    /// Enqueue an event. If the bridge is already ready the event is
    /// dispatched immediately; otherwise it is held until `flushQueue()`.
    func enqueueEvent(_ event: QueuedBleEvent) {
        queue.sync {
            if isBridgeReady, let handler = eventHandler {
                DispatchQueue.main.async {
                    handler(event)
                }
            } else {
                pendingEvents.append(event)
            }
        }
    }

    /// Mark the bridge as ready and flush all pending events.
    func markBridgeReady() {
        queue.sync {
            isBridgeReady = true
            guard let handler = eventHandler else { return }
            let events = pendingEvents
            pendingEvents.removeAll()
            DispatchQueue.main.async {
                for event in events {
                    handler(event)
                }
            }
        }
    }

    /// Reset bridge readiness (e.g., on bridge reload).
    func markBridgeNotReady() {
        queue.sync {
            isBridgeReady = false
        }
    }

    // MARK: - Restored Peripheral Tracking

    /// Register a peripheral that was restored by the system and needs
    /// service/characteristic re-discovery.
    func addRestoredPeripheral(_ peripheral: CBPeripheral) {
        let key = peripheral.identifier.uuidString
        restoredPeripherals[key] = peripheral
    }

    /// Retrieve and remove a restored peripheral by its identifier.
    /// Returns `nil` if the peripheral was not part of the restoration set.
    func consumeRestoredPeripheral(identifier: String) -> CBPeripheral? {
        return restoredPeripherals.removeValue(forKey: identifier)
    }

    /// All currently tracked restored peripherals.
    var allRestoredPeripherals: [CBPeripheral] {
        return Array(restoredPeripherals.values)
    }

    /// Remove all restored peripheral references.
    func clearRestoredPeripherals() {
        restoredPeripherals.removeAll()
    }

    // MARK: - Central Manager Restoration

    /// Called from `BleCentralManager.centralManager(_:willRestoreState:)`.
    ///
    /// Extracts restored peripherals and scan services from the restoration
    /// dictionary and prepares them for re-subscription once the managers
    /// are fully initialized.
    func handleCentralRestoration(dict: [String: Any]) {
        // Restored peripherals that were connected or pending connection.
        if let peripherals = dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral] {
            for peripheral in peripherals {
                addRestoredPeripheral(peripheral)
                // Emit a connection event so the JS side knows about
                // previously connected peers.
                let state: String
                switch peripheral.state {
                case .connected:
                    state = "connected"
                case .connecting:
                    state = "connecting"
                default:
                    state = "disconnected"
                }
                enqueueEvent(.connectionStateChanged(
                    peerId: peripheral.identifier.uuidString,
                    state: state
                ))
            }
        }

        // Restored scan services -- we may want to resume scanning for
        // these UUIDs once the central manager powers on.
        // (Handled in BleCentralManager's centralManagerDidUpdateState.)
    }

    // MARK: - Peripheral Manager Restoration

    /// Called from `BlePeripheralManager.peripheralManager(_:willRestoreState:)`.
    ///
    /// Restores the advertising state if the peripheral manager was
    /// advertising before the app was terminated.
    func handlePeripheralRestoration(dict: [String: Any]) {
        // The restored advertising data; if non-nil the peripheral manager
        // was advertising when the app was terminated. The actual re-start
        // of advertising is handled in BlePeripheralManager once the
        // peripheral manager enters the powered-on state.
        if let advertisingData = dict[CBPeripheralManagerRestoredStateAdvertisementDataKey] as? [String: Any] {
            // Store for the peripheral manager to inspect.
            _ = advertisingData // Handled by BlePeripheralManager
        }

        // Restored services that had been published.
        // BlePeripheralManager will re-add services if needed.
        if let services = dict[CBPeripheralManagerRestoredStateServicesKey] as? [CBMutableService] {
            _ = services // Handled by BlePeripheralManager
        }
    }
}
