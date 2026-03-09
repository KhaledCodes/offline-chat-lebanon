//
//  BleCentralManager.swift
//  Jisr
//
//  CBCentralManager wrapper that handles scanning for peripherals advertising
//  the Jisr GATT service, connecting to them, discovering characteristics,
//  and reading/writing data.
//
//  All public methods are designed to be called from the main queue.
//

import Foundation
import CoreBluetooth

// MARK: - Delegate Protocol

/// Delegate protocol for BleCentralManager events that need to be forwarded
/// to the React Native bridge (BleModule).
protocol BleCentralManagerDelegate: AnyObject {
    func centralManagerDidUpdateBleState(_ state: CBManagerState)
    func centralManagerDidDiscoverPeer(peripheralId: String, name: String, rssi: NSNumber)
    func centralManagerDidConnectPeer(peripheralId: String)
    func centralManagerDidDisconnectPeer(peripheralId: String, error: Error?)
    func centralManagerDidFailToConnectPeer(peripheralId: String, error: Error?)
    func centralManagerDidReceiveData(peripheralId: String, data: Data)
    func centralManagerDidReadPeerId(peripheralId: String, peerId: String)
    func centralManagerDidUpdateMtu(peripheralId: String, mtu: Int)
}

// MARK: - Pending Operation Types

/// Tracks a pending connect promise from the JS side.
private struct PendingConnect {
    let resolve: (Any?) -> Void
    let reject: (String?, String?, Error?) -> Void
}

/// Tracks a pending read-characteristic promise from the JS side.
private struct PendingRead {
    let resolve: (Any?) -> Void
    let reject: (String?, String?, Error?) -> Void
}

/// Tracks a pending write-characteristic promise from the JS side.
private struct PendingWrite {
    let resolve: (Any?) -> Void
    let reject: (String?, String?, Error?) -> Void
}

// MARK: - BleCentralManager

final class BleCentralManager: NSObject {

    // MARK: Properties

    weak var delegate: BleCentralManagerDelegate?

    private var centralManager: CBCentralManager?

    /// Discovered peripherals keyed by UUID string.
    /// We must retain strong references to peripherals or CoreBluetooth
    /// will deallocate them and the connection will fail.
    private var discoveredPeripherals: [String: CBPeripheral] = [:]

    /// Connected peripherals keyed by UUID string.
    private var connectedPeripherals: [String: CBPeripheral] = [:]

    /// Discovered TX characteristics keyed by peripheral UUID string.
    private var txCharacteristics: [String: CBCharacteristic] = [:]

    /// Discovered RX characteristics keyed by peripheral UUID string.
    private var rxCharacteristics: [String: CBCharacteristic] = [:]

    /// Discovered PEER_ID characteristics keyed by peripheral UUID string.
    private var peerIdCharacteristics: [String: CBCharacteristic] = [:]

    /// The service UUID currently being scanned for.
    private var scanServiceUUID: CBUUID?

    /// Whether scanning should resume once the central manager powers on.
    private var shouldResumeScanning = false

    // -- Pending operations ---------------------------------------------------

    /// Pending connection promises keyed by peripheral UUID string.
    private var pendingConnects: [String: PendingConnect] = [:]

    /// Pending read promises keyed by "peripheralId:characteristicUuid".
    private var pendingReads: [String: PendingRead] = [:]

    /// Pending write promises keyed by "peripheralId:characteristicUuid".
    private var pendingWrites: [String: PendingWrite] = [:]

    // MARK: - Initialization

    /// Create and power on the central manager with state restoration support.
    func initialize() {
        guard centralManager == nil else { return }

        centralManager = CBCentralManager(
            delegate: self,
            queue: DispatchQueue.main,
            options: [
                CBCentralManagerOptionRestoreIdentifierKey: kCentralRestorationIdentifier,
                CBCentralManagerOptionShowPowerAlertKey: true
            ]
        )
    }

    // MARK: - Scanning

    /// Start scanning for peripherals advertising the given service UUID.
    func startScanning(serviceUuid: CBUUID) {
        scanServiceUUID = serviceUuid
        shouldResumeScanning = true

        guard let cm = centralManager, cm.state == .poweredOn else {
            // Will start scanning once the state transitions to poweredOn.
            return
        }

        cm.scanForPeripherals(
            withServices: [serviceUuid],
            options: [
                CBCentralManagerScanOptionAllowDuplicatesKey: true
            ]
        )
    }

    /// Stop the current scan.
    func stopScanning() {
        shouldResumeScanning = false
        centralManager?.stopScan()
    }

    // MARK: - Connection

    /// Initiate a connection to a previously discovered peripheral.
    func connectToPeripheral(
        peripheralId: String,
        serviceUuid: CBUUID,
        resolve: @escaping (Any?) -> Void,
        reject: @escaping (String?, String?, Error?) -> Void
    ) {
        guard let peripheral = discoveredPeripherals[peripheralId]
                ?? connectedPeripherals[peripheralId]
                ?? StateRestorationHandler.shared.consumeRestoredPeripheral(identifier: peripheralId)
        else {
            reject("PERIPHERAL_NOT_FOUND",
                   "Peripheral \(peripheralId) has not been discovered.", nil)
            return
        }

        // Store the service UUID so we know which services to discover.
        scanServiceUUID = serviceUuid

        pendingConnects[peripheralId] = PendingConnect(resolve: resolve, reject: reject)
        peripheral.delegate = self
        centralManager?.connect(peripheral, options: nil)

        // Emit connecting state.
        delegate?.centralManagerDidUpdateBleState(centralManager?.state ?? .unknown)
    }

    /// Cancel a connection or pending connection to a peripheral.
    func disconnectPeripheral(peripheralId: String) {
        if let peripheral = connectedPeripherals[peripheralId]
                ?? discoveredPeripherals[peripheralId] {
            centralManager?.cancelPeripheralConnection(peripheral)
        }

        // Clean up tracked state for this peripheral.
        cleanupPeripheral(peripheralId: peripheralId)
    }

    // MARK: - Read Characteristic

    /// Read the value of a characteristic on a connected peripheral.
    func readCharacteristic(
        peripheralId: String,
        serviceUuid: CBUUID,
        characteristicUuid: CBUUID,
        resolve: @escaping (Any?) -> Void,
        reject: @escaping (String?, String?, Error?) -> Void
    ) {
        guard let peripheral = connectedPeripherals[peripheralId] else {
            reject("NOT_CONNECTED",
                   "Peripheral \(peripheralId) is not connected.", nil)
            return
        }

        let characteristic = findCharacteristic(
            uuid: characteristicUuid,
            serviceUuid: serviceUuid,
            peripheral: peripheral
        )

        guard let char = characteristic else {
            reject("CHARACTERISTIC_NOT_FOUND",
                   "Characteristic \(characteristicUuid.uuidString) not found on \(peripheralId).", nil)
            return
        }

        let key = "\(peripheralId):\(characteristicUuid.uuidString)"
        pendingReads[key] = PendingRead(resolve: resolve, reject: reject)
        peripheral.readValue(for: char)
    }

    // MARK: - Write Characteristic

    /// Write data to a characteristic on a connected peripheral.
    /// Uses write-without-response for the TX characteristic, write-with-response
    /// for others.
    func writeCharacteristic(
        peripheralId: String,
        serviceUuid: CBUUID,
        characteristicUuid: CBUUID,
        data: Data,
        resolve: @escaping (Any?) -> Void,
        reject: @escaping (String?, String?, Error?) -> Void
    ) {
        guard let peripheral = connectedPeripherals[peripheralId] else {
            reject("NOT_CONNECTED",
                   "Peripheral \(peripheralId) is not connected.", nil)
            return
        }

        let characteristic = findCharacteristic(
            uuid: characteristicUuid,
            serviceUuid: serviceUuid,
            peripheral: peripheral
        )

        guard let char = characteristic else {
            reject("CHARACTERISTIC_NOT_FOUND",
                   "Characteristic \(characteristicUuid.uuidString) not found on \(peripheralId).", nil)
            return
        }

        // TX characteristic uses write-without-response for throughput.
        let writeType: CBCharacteristicWriteType =
            char.properties.contains(.writeWithoutResponse)
                ? .withoutResponse
                : .withResponse

        if writeType == .withoutResponse {
            peripheral.writeValue(data, for: char, type: .withoutResponse)
            resolve(nil)
        } else {
            let key = "\(peripheralId):\(characteristicUuid.uuidString)"
            pendingWrites[key] = PendingWrite(resolve: resolve, reject: reject)
            peripheral.writeValue(data, for: char, type: .withResponse)
        }
    }

    // MARK: - MTU

    /// On iOS the MTU is negotiated automatically. This method returns the
    /// maximum write value length for the peripheral (the effective MTU payload).
    func getEffectiveMtu(peripheralId: String) -> Int? {
        guard let peripheral = connectedPeripherals[peripheralId] else {
            return nil
        }
        // maximumWriteValueLength returns the maximum number of bytes that
        // can be written in a single packet for .withoutResponse writes.
        return peripheral.maximumWriteValueLength(for: .withoutResponse)
    }

    // MARK: - Connected Peripherals

    /// Return the identifiers of all currently connected peripherals that
    /// have the specified service.
    func getConnectedPeripherals(serviceUuid: CBUUID) -> [String] {
        // Ask the system for connected peripherals with the given service.
        guard let cm = centralManager else { return [] }
        let systemConnected = cm.retrieveConnectedPeripherals(withServices: [serviceUuid])

        // Merge with our own tracking.
        var ids = Set(connectedPeripherals.keys)
        for peripheral in systemConnected {
            let key = peripheral.identifier.uuidString
            ids.insert(key)
            // Retain references.
            if discoveredPeripherals[key] == nil {
                discoveredPeripherals[key] = peripheral
            }
        }

        return Array(ids)
    }

    // MARK: - Restoration Handling

    /// Re-subscribe to characteristics on peripherals that were restored
    /// by the system.
    func handleRestoredPeripherals() {
        let restored = StateRestorationHandler.shared.allRestoredPeripherals
        for peripheral in restored {
            let peripheralId = peripheral.identifier.uuidString
            peripheral.delegate = self

            if peripheral.state == .connected {
                connectedPeripherals[peripheralId] = peripheral
                discoveredPeripherals[peripheralId] = peripheral

                // Re-discover services to re-subscribe to characteristics.
                if let serviceUuid = scanServiceUUID {
                    peripheral.discoverServices([serviceUuid])
                } else {
                    peripheral.discoverServices(nil)
                }
            } else if peripheral.state == .disconnected {
                // Attempt reconnection.
                centralManager?.connect(peripheral, options: nil)
                discoveredPeripherals[peripheralId] = peripheral
            }
        }

        StateRestorationHandler.shared.clearRestoredPeripherals()
    }

    // MARK: - Private Helpers

    /// Find a cached characteristic on a peripheral by UUID.
    private func findCharacteristic(
        uuid: CBUUID,
        serviceUuid: CBUUID,
        peripheral: CBPeripheral
    ) -> CBCharacteristic? {
        let peripheralId = peripheral.identifier.uuidString

        // Check our caches first.
        if uuid.uuidString.uppercased() == BleUUIDs.txCharacteristic.uuidString.uppercased() {
            return txCharacteristics[peripheralId]
        }
        if uuid.uuidString.uppercased() == BleUUIDs.rxCharacteristic.uuidString.uppercased() {
            return rxCharacteristics[peripheralId]
        }
        if uuid.uuidString.uppercased() == BleUUIDs.peerIdCharacteristic.uuidString.uppercased() {
            return peerIdCharacteristics[peripheralId]
        }

        // Fall back to iterating discovered services/characteristics.
        guard let services = peripheral.services else { return nil }
        for service in services where service.uuid == serviceUuid {
            guard let chars = service.characteristics else { continue }
            for char in chars where char.uuid == uuid {
                return char
            }
        }
        return nil
    }

    /// Clean up all tracked state for a disconnected peripheral.
    private func cleanupPeripheral(peripheralId: String) {
        connectedPeripherals.removeValue(forKey: peripheralId)
        txCharacteristics.removeValue(forKey: peripheralId)
        rxCharacteristics.removeValue(forKey: peripheralId)
        peerIdCharacteristics.removeValue(forKey: peripheralId)

        // Cancel any pending operations.
        if let pending = pendingConnects.removeValue(forKey: peripheralId) {
            pending.reject("DISCONNECTED",
                           "Connection cancelled for \(peripheralId).", nil)
        }

        // Cancel pending reads/writes for this peripheral.
        let readKeys = pendingReads.keys.filter { $0.hasPrefix(peripheralId) }
        for key in readKeys {
            if let pending = pendingReads.removeValue(forKey: key) {
                pending.reject("DISCONNECTED",
                               "Peripheral disconnected during read.", nil)
            }
        }

        let writeKeys = pendingWrites.keys.filter { $0.hasPrefix(peripheralId) }
        for key in writeKeys {
            if let pending = pendingWrites.removeValue(forKey: key) {
                pending.reject("DISCONNECTED",
                               "Peripheral disconnected during write.", nil)
            }
        }
    }
}

// MARK: - CBCentralManagerDelegate

extension BleCentralManager: CBCentralManagerDelegate {

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        delegate?.centralManagerDidUpdateBleState(central.state)

        switch central.state {
        case .poweredOn:
            // Resume scanning if requested before power-on.
            if shouldResumeScanning, let serviceUuid = scanServiceUUID {
                central.scanForPeripherals(
                    withServices: [serviceUuid],
                    options: [CBCentralManagerScanOptionAllowDuplicatesKey: true]
                )
            }

            // Handle any restored peripherals.
            handleRestoredPeripherals()

        case .poweredOff, .unauthorized, .unsupported:
            // Clear scanning state; it will need to be re-requested.
            shouldResumeScanning = false

        default:
            break
        }
    }

    func centralManager(
        _ central: CBCentralManager,
        willRestoreState dict: [String: Any]
    ) {
        StateRestorationHandler.shared.handleCentralRestoration(dict: dict)
    }

    func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        let peripheralId = peripheral.identifier.uuidString

        // Retain a strong reference.
        discoveredPeripherals[peripheralId] = peripheral

        // Extract the local name from the advertisement data, falling back
        // to the peripheral's name property.
        let name = advertisementData[CBAdvertisementDataLocalNameKey] as? String
            ?? peripheral.name
            ?? "Unknown"

        delegate?.centralManagerDidDiscoverPeer(
            peripheralId: peripheralId,
            name: name,
            rssi: RSSI
        )
    }

    func centralManager(
        _ central: CBCentralManager,
        didConnect peripheral: CBPeripheral
    ) {
        let peripheralId = peripheral.identifier.uuidString
        connectedPeripherals[peripheralId] = peripheral
        peripheral.delegate = self

        // Discover the Jisr service and its characteristics.
        if let serviceUuid = scanServiceUUID {
            peripheral.discoverServices([serviceUuid])
        } else {
            peripheral.discoverServices(nil)
        }

        delegate?.centralManagerDidConnectPeer(peripheralId: peripheralId)
    }

    func centralManager(
        _ central: CBCentralManager,
        didFailToConnect peripheral: CBPeripheral,
        error: Error?
    ) {
        let peripheralId = peripheral.identifier.uuidString

        delegate?.centralManagerDidFailToConnectPeer(
            peripheralId: peripheralId,
            error: error
        )

        if let pending = pendingConnects.removeValue(forKey: peripheralId) {
            pending.reject(
                "CONNECTION_FAILED",
                "Failed to connect to \(peripheralId): \(error?.localizedDescription ?? "unknown error")",
                error
            )
        }

        cleanupPeripheral(peripheralId: peripheralId)
    }

    func centralManager(
        _ central: CBCentralManager,
        didDisconnectPeripheral peripheral: CBPeripheral,
        error: Error?
    ) {
        let peripheralId = peripheral.identifier.uuidString

        delegate?.centralManagerDidDisconnectPeer(
            peripheralId: peripheralId,
            error: error
        )

        cleanupPeripheral(peripheralId: peripheralId)

        // Auto-reconnect if the disconnection was unexpected (error != nil)
        // and we still have a reference to the peripheral.
        if error != nil, let discoveredPeripheral = discoveredPeripherals[peripheralId] {
            central.connect(discoveredPeripheral, options: nil)
        }
    }
}

// MARK: - CBPeripheralDelegate

extension BleCentralManager: CBPeripheralDelegate {

    func peripheral(
        _ peripheral: CBPeripheral,
        didDiscoverServices error: Error?
    ) {
        let peripheralId = peripheral.identifier.uuidString

        if let error = error {
            NSLog("[BleCentralManager] Service discovery error for \(peripheralId): \(error)")
            return
        }

        guard let services = peripheral.services else { return }
        for service in services {
            // Discover all characteristics for the Jisr service.
            peripheral.discoverCharacteristics(
                [
                    BleUUIDs.txCharacteristic,
                    BleUUIDs.rxCharacteristic,
                    BleUUIDs.peerIdCharacteristic
                ],
                for: service
            )
        }
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didDiscoverCharacteristicsFor service: CBService,
        error: Error?
    ) {
        let peripheralId = peripheral.identifier.uuidString

        if let error = error {
            NSLog("[BleCentralManager] Characteristic discovery error for \(peripheralId): \(error)")
            return
        }

        guard let characteristics = service.characteristics else { return }

        for characteristic in characteristics {
            switch characteristic.uuid {
            case BleUUIDs.txCharacteristic:
                txCharacteristics[peripheralId] = characteristic

            case BleUUIDs.rxCharacteristic:
                rxCharacteristics[peripheralId] = characteristic
                // Subscribe to notifications on the RX characteristic.
                peripheral.setNotifyValue(true, for: characteristic)

            case BleUUIDs.peerIdCharacteristic:
                peerIdCharacteristics[peripheralId] = characteristic
                // Automatically read the peer ID.
                peripheral.readValue(for: characteristic)

            default:
                break
            }
        }

        // Resolve the pending connect promise once characteristics are discovered.
        if let pending = pendingConnects.removeValue(forKey: peripheralId) {
            pending.resolve(nil)
        }

        // Report the effective MTU.
        let mtu = peripheral.maximumWriteValueLength(for: .withoutResponse) + 3
        delegate?.centralManagerDidUpdateMtu(peripheralId: peripheralId, mtu: mtu)
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didUpdateValueFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        let peripheralId = peripheral.identifier.uuidString

        if let error = error {
            NSLog("[BleCentralManager] Characteristic update error for \(peripheralId): \(error)")

            // Reject any pending read for this characteristic.
            let key = "\(peripheralId):\(characteristic.uuid.uuidString)"
            if let pending = pendingReads.removeValue(forKey: key) {
                pending.reject("READ_ERROR", error.localizedDescription, error)
            }
            return
        }

        guard let data = characteristic.value else { return }

        switch characteristic.uuid {
        case BleUUIDs.peerIdCharacteristic:
            // PEER_ID is a UTF-8 encoded peer identifier string.
            let peerId = String(data: data, encoding: .utf8) ?? peripheralId

            // Resolve pending read if any.
            let key = "\(peripheralId):\(characteristic.uuid.uuidString)"
            if let pending = pendingReads.removeValue(forKey: key) {
                let base64 = data.base64EncodedString()
                pending.resolve(base64)
            }

            delegate?.centralManagerDidReadPeerId(
                peripheralId: peripheralId,
                peerId: peerId
            )

        case BleUUIDs.rxCharacteristic:
            // Data received from the remote peer via notification.
            delegate?.centralManagerDidReceiveData(
                peripheralId: peripheralId,
                data: data
            )

        default:
            // Generic characteristic read.
            let key = "\(peripheralId):\(characteristic.uuid.uuidString)"
            if let pending = pendingReads.removeValue(forKey: key) {
                let base64 = data.base64EncodedString()
                pending.resolve(base64)
            }
        }
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didWriteValueFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        let peripheralId = peripheral.identifier.uuidString
        let key = "\(peripheralId):\(characteristic.uuid.uuidString)"

        guard let pending = pendingWrites.removeValue(forKey: key) else { return }

        if let error = error {
            pending.reject("WRITE_ERROR", error.localizedDescription, error)
        } else {
            pending.resolve(nil)
        }
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didUpdateNotificationStateFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        let peripheralId = peripheral.identifier.uuidString

        if let error = error {
            NSLog("[BleCentralManager] Notification state error for \(peripheralId), " +
                  "char \(characteristic.uuid): \(error)")
            return
        }

        if characteristic.isNotifying {
            NSLog("[BleCentralManager] Subscribed to notifications on \(characteristic.uuid) " +
                  "for peripheral \(peripheralId)")
        } else {
            NSLog("[BleCentralManager] Unsubscribed from notifications on \(characteristic.uuid) " +
                  "for peripheral \(peripheralId)")
        }
    }

    func peripheralDidUpdateName(_ peripheral: CBPeripheral) {
        // Name changes are handled via re-discovery advertisements.
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didReadRSSI RSSI: NSNumber,
        error: Error?
    ) {
        // RSSI updates are primarily handled via scan results.
    }
}
