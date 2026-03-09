//
//  BlePeripheralManager.swift
//  Jisr
//
//  CBPeripheralManager wrapper that sets up the Jisr GATT service and handles
//  advertising, incoming connections from centrals, read/write requests, and
//  sending notifications to subscribed centrals.
//
//  GATT Layout:
//    Service: 4A530000-0000-1000-8000-00805F9B34FB
//      TX Characteristic: 4A540000-... (write without response) -- central writes here to send us data
//      RX Characteristic: 4A520000-... (notify)                 -- we notify centrals with outgoing data
//      PEER_ID Characteristic: 4A500000-... (read)              -- centrals read our stable peer ID
//
//  Note on naming convention: "TX" and "RX" are from the **central's** perspective.
//    - TX (on the peripheral) receives writes from centrals.
//    - RX (on the peripheral) sends notifications to centrals.
//

import Foundation
import CoreBluetooth

// MARK: - Delegate Protocol

/// Events from the peripheral manager that need to reach the BleModule / bridge.
protocol BlePeripheralManagerDelegate: AnyObject {
    func peripheralManagerDidUpdateBleState(_ state: CBManagerState)
    func peripheralManagerDidReceiveData(fromCentral centralId: String, data: Data)
    func peripheralManagerDidSubscribeCentral(_ centralId: String)
    func peripheralManagerDidUnsubscribeCentral(_ centralId: String)
}

// MARK: - BlePeripheralManager

final class BlePeripheralManager: NSObject {

    // MARK: Properties

    weak var delegate: BlePeripheralManagerDelegate?

    private var peripheralManager: CBPeripheralManager?

    /// The mutable service we publish.
    private var jisrService: CBMutableService?

    /// The mutable characteristics retained for modifying values and
    /// sending notifications.
    private var txCharacteristic: CBMutableCharacteristic?
    private var rxCharacteristic: CBMutableCharacteristic?
    private var peerIdCharacteristic: CBMutableCharacteristic?

    /// The local peer identifier that is served via the PEER_ID characteristic.
    private var localPeerId: String?

    /// The local name used in advertising packets.
    private var localName: String = "Jisr"

    /// Whether the service has been successfully added to the peripheral manager.
    private var isServicePublished = false

    /// Whether advertising should (re-)start once the peripheral manager
    /// enters the powered-on state.
    private var shouldResumeAdvertising = false

    /// The service UUID to advertise.
    private var advertisingServiceUUID: CBUUID?

    /// Centrals that are currently subscribed to the RX characteristic.
    /// Keyed by the central's identifier UUID string.
    private var subscribedCentrals: [String: CBCentral] = [:]

    /// Data that could not be sent because the transmit queue was full.
    /// Will be retried when `peripheralManagerIsReady(toUpdateSubscribers:)` fires.
    private var pendingNotifications: [(data: Data, centrals: [CBCentral])] = []

    // MARK: - Initialization

    /// Create and power on the peripheral manager with state restoration.
    func initialize() {
        guard peripheralManager == nil else { return }

        peripheralManager = CBPeripheralManager(
            delegate: self,
            queue: DispatchQueue.main,
            options: [
                CBPeripheralManagerOptionRestoreIdentifierKey: kPeripheralRestorationIdentifier,
                CBPeripheralManagerOptionShowPowerAlertKey: true
            ]
        )
    }

    // MARK: - Service Setup

    /// Build and publish the Jisr GATT service with its three characteristics.
    private func publishService() {
        guard let pm = peripheralManager, !isServicePublished else { return }

        // TX Characteristic -- centrals write data to us here.
        // Write without response for maximum throughput.
        let tx = CBMutableCharacteristic(
            type: BleUUIDs.txCharacteristic,
            properties: [.write, .writeWithoutResponse],
            value: nil,  // Dynamic value (handled in didReceiveWrite).
            permissions: [.writeable]
        )

        // RX Characteristic -- we notify centrals with outgoing data.
        let rx = CBMutableCharacteristic(
            type: BleUUIDs.rxCharacteristic,
            properties: [.notify],
            value: nil,  // Dynamic value (updated via updateValue).
            permissions: [.readable]
        )

        // PEER_ID Characteristic -- centrals read our stable peer identity.
        // The value is set statically when advertising starts.
        let peerId = CBMutableCharacteristic(
            type: BleUUIDs.peerIdCharacteristic,
            properties: [.read],
            value: nil,  // Dynamic -- we respond in didReceiveRead.
            permissions: [.readable]
        )

        txCharacteristic = tx
        rxCharacteristic = rx
        peerIdCharacteristic = peerId

        let service = CBMutableService(
            type: BleUUIDs.service,
            primary: true
        )
        service.characteristics = [tx, rx, peerId]
        jisrService = service

        pm.add(service)
    }

    // MARK: - Advertising

    /// Start advertising the Jisr service.
    ///
    /// - Parameters:
    ///   - serviceUuid: The service UUID to include in the advertisement.
    ///   - localName: The local name to advertise.
    ///   - peerId: The stable peer identifier to serve on the PEER_ID characteristic.
    func startAdvertising(serviceUuid: CBUUID, localName: String, peerId: String) {
        self.localPeerId = peerId
        self.localName = localName
        self.advertisingServiceUUID = serviceUuid
        self.shouldResumeAdvertising = true

        guard let pm = peripheralManager, pm.state == .poweredOn else {
            // Will start once powered on.
            return
        }

        if !isServicePublished {
            publishService()
            // Advertising will be started in peripheralManager(_:didAdd:error:).
            return
        }

        beginAdvertising()
    }

    /// Stop advertising.
    func stopAdvertising() {
        shouldResumeAdvertising = false
        peripheralManager?.stopAdvertising()
    }

    // MARK: - Sending Data to Subscribed Centrals

    /// Send data to all subscribed centrals via the RX characteristic notification.
    ///
    /// - Parameter data: The raw data to send.
    /// - Returns: `true` if the data was queued successfully, `false` if the
    ///   transmit queue is full (will retry automatically).
    @discardableResult
    func sendDataToSubscribers(_ data: Data) -> Bool {
        guard let rx = rxCharacteristic, let pm = peripheralManager else {
            return false
        }

        let centrals = Array(subscribedCentrals.values)
        guard !centrals.isEmpty else { return false }

        let success = pm.updateValue(data, for: rx, onSubscribedCentrals: centrals)

        if !success {
            // Queue for retry when the system signals readiness.
            pendingNotifications.append((data: data, centrals: centrals))
        }

        return success
    }

    /// Send data to a specific subscribed central.
    ///
    /// - Parameters:
    ///   - data: The raw data to send.
    ///   - centralId: The identifier of the target central.
    /// - Returns: `true` if sent successfully.
    @discardableResult
    func sendData(_ data: Data, toCentral centralId: String) -> Bool {
        guard let rx = rxCharacteristic,
              let pm = peripheralManager,
              let central = subscribedCentrals[centralId]
        else {
            return false
        }

        let success = pm.updateValue(data, for: rx, onSubscribedCentrals: [central])

        if !success {
            pendingNotifications.append((data: data, centrals: [central]))
        }

        return success
    }

    // MARK: - Query

    /// Return the identifiers of all currently subscribed centrals.
    var subscribedCentralIds: [String] {
        return Array(subscribedCentrals.keys)
    }

    // MARK: - Private

    private func beginAdvertising() {
        guard let pm = peripheralManager, !pm.isAdvertising else { return }

        let advertisementData: [String: Any] = [
            CBAdvertisementDataServiceUUIDsKey: [advertisingServiceUUID ?? BleUUIDs.service],
            CBAdvertisementDataLocalNameKey: localName
        ]

        pm.startAdvertising(advertisementData)
    }

    /// Retry sending queued notifications that failed due to a full transmit queue.
    private func flushPendingNotifications() {
        guard let rx = rxCharacteristic, let pm = peripheralManager else { return }

        while !pendingNotifications.isEmpty {
            let pending = pendingNotifications.first!
            let success = pm.updateValue(
                pending.data,
                for: rx,
                onSubscribedCentrals: pending.centrals
            )
            if success {
                pendingNotifications.removeFirst()
            } else {
                // Still full; wait for the next readiness callback.
                break
            }
        }
    }
}

// MARK: - CBPeripheralManagerDelegate

extension BlePeripheralManager: CBPeripheralManagerDelegate {

    func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        delegate?.peripheralManagerDidUpdateBleState(peripheral.state)

        switch peripheral.state {
        case .poweredOn:
            if shouldResumeAdvertising {
                if !isServicePublished {
                    publishService()
                } else {
                    beginAdvertising()
                }
            }

        case .poweredOff, .unauthorized, .unsupported:
            isServicePublished = false
            subscribedCentrals.removeAll()
            pendingNotifications.removeAll()

        default:
            break
        }
    }

    func peripheralManager(
        _ peripheral: CBPeripheralManager,
        willRestoreState dict: [String: Any]
    ) {
        StateRestorationHandler.shared.handlePeripheralRestoration(dict: dict)

        // If services were restored, mark as published.
        if let services = dict[CBPeripheralManagerRestoredStateServicesKey] as? [CBMutableService] {
            for service in services where service.uuid == BleUUIDs.service {
                jisrService = service
                isServicePublished = true

                // Re-extract characteristic references.
                if let chars = service.characteristics {
                    for char in chars {
                        if let mutableChar = char as? CBMutableCharacteristic {
                            switch mutableChar.uuid {
                            case BleUUIDs.txCharacteristic:
                                txCharacteristic = mutableChar
                            case BleUUIDs.rxCharacteristic:
                                rxCharacteristic = mutableChar
                            case BleUUIDs.peerIdCharacteristic:
                                peerIdCharacteristic = mutableChar
                            default:
                                break
                            }
                        }
                    }
                }
            }
        }

        // If advertising data was restored, we were advertising.
        if dict[CBPeripheralManagerRestoredStateAdvertisementDataKey] != nil {
            shouldResumeAdvertising = true
        }
    }

    func peripheralManager(
        _ peripheral: CBPeripheralManager,
        didAdd service: CBService,
        error: Error?
    ) {
        if let error = error {
            NSLog("[BlePeripheralManager] Failed to add service: \(error)")
            return
        }

        NSLog("[BlePeripheralManager] Service published: \(service.uuid)")
        isServicePublished = true

        // Now that the service is added, start advertising if requested.
        if shouldResumeAdvertising {
            beginAdvertising()
        }
    }

    func peripheralManagerDidStartAdvertising(
        _ peripheral: CBPeripheralManager,
        error: Error?
    ) {
        if let error = error {
            NSLog("[BlePeripheralManager] Failed to start advertising: \(error)")
            return
        }
        NSLog("[BlePeripheralManager] Advertising started.")
    }

    // MARK: Read Requests

    func peripheralManager(
        _ peripheral: CBPeripheralManager,
        didReceiveRead request: CBATTRequest
    ) {
        switch request.characteristic.uuid {
        case BleUUIDs.peerIdCharacteristic:
            // Respond with the local peer ID encoded as UTF-8.
            guard let peerId = localPeerId,
                  let data = peerId.data(using: .utf8) else {
                peripheral.respond(to: request, withResult: .unlikelyError)
                return
            }

            // Handle offset reads (for large values split across multiple reads).
            if request.offset > data.count {
                peripheral.respond(to: request, withResult: .invalidOffset)
                return
            }

            request.value = data.subdata(in: request.offset..<data.count)
            peripheral.respond(to: request, withResult: .success)

        default:
            peripheral.respond(to: request, withResult: .attributeNotFound)
        }
    }

    // MARK: Write Requests

    func peripheralManager(
        _ peripheral: CBPeripheralManager,
        didReceiveWrite requests: [CBATTRequest]
    ) {
        for request in requests {
            guard request.characteristic.uuid == BleUUIDs.txCharacteristic else {
                peripheral.respond(to: request, withResult: .attributeNotFound)
                continue
            }

            guard let data = request.value else {
                peripheral.respond(to: request, withResult: .unlikelyError)
                continue
            }

            let centralId = request.central.identifier.uuidString

            // Forward received data to the delegate (and ultimately to JS).
            delegate?.peripheralManagerDidReceiveData(
                fromCentral: centralId,
                data: data
            )

            // Respond with success for write-with-response requests.
            // For write-without-response, CoreBluetooth does not call this
            // delegate method at all, so we only get here for .write requests.
            peripheral.respond(to: request, withResult: .success)
        }
    }

    // MARK: Subscription Management

    func peripheralManager(
        _ peripheral: CBPeripheralManager,
        central: CBCentral,
        didSubscribeTo characteristic: CBCharacteristic
    ) {
        guard characteristic.uuid == BleUUIDs.rxCharacteristic else { return }

        let centralId = central.identifier.uuidString
        subscribedCentrals[centralId] = central

        NSLog("[BlePeripheralManager] Central \(centralId) subscribed to RX.")

        delegate?.peripheralManagerDidSubscribeCentral(centralId)
    }

    func peripheralManager(
        _ peripheral: CBPeripheralManager,
        central: CBCentral,
        didUnsubscribeFrom characteristic: CBCharacteristic
    ) {
        guard characteristic.uuid == BleUUIDs.rxCharacteristic else { return }

        let centralId = central.identifier.uuidString
        subscribedCentrals.removeValue(forKey: centralId)

        NSLog("[BlePeripheralManager] Central \(centralId) unsubscribed from RX.")

        delegate?.peripheralManagerDidUnsubscribeCentral(centralId)
    }

    // MARK: Transmit Queue Ready

    func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) {
        // The transmit queue has space again. Flush any pending notifications.
        flushPendingNotifications()
    }
}
