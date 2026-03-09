//
//  BleModule.swift
//  Jisr
//
//  React Native native module that bridges the CoreBluetooth BLE stack to
//  JavaScript. Acts as the single entry point for the JS side via
//  NativeModules.BleNativeModule.
//
//  This module:
//    - Exposes promise-based methods matching BleNativeModuleInterface in
//      src/ble/BleService.ts.
//    - Emits events to JS via RCTEventEmitter matching the event names
//      the JS side subscribes to (BleNative_*).
//    - Coordinates BleCentralManager and BlePeripheralManager internally.
//

import Foundation
import CoreBluetooth

// MARK: - GATT UUIDs

/// Centralised UUID constants for the Jisr BLE GATT service.
/// Using the custom 128-bit UUIDs specified in the project spec.
struct BleUUIDs {
    static let service            = CBUUID(string: "4A530000-0000-1000-8000-00805F9B34FB")
    static let txCharacteristic   = CBUUID(string: "4A540000-0000-1000-8000-00805F9B34FB")
    static let rxCharacteristic   = CBUUID(string: "4A520000-0000-1000-8000-00805F9B34FB")
    static let peerIdCharacteristic = CBUUID(string: "4A500000-0000-1000-8000-00805F9B34FB")
}

// MARK: - Event Names

/// String constants for the event names emitted to JavaScript.
/// Must match the names used in BleService.ts addListener calls.
private enum BleEventName: String, CaseIterable {
    case peerDiscovered         = "BleNative_PeerDiscovered"
    case peerLost               = "BleNative_PeerLost"
    case dataReceived           = "BleNative_DataReceived"
    case connectionStateChanged = "BleNative_ConnectionStateChanged"
    case mtuChanged             = "BleNative_MtuChanged"
    case bleStateChanged        = "BleNative_BleStateChanged"
}

// MARK: - BleNativeModule

/// The React Native bridge module for BLE operations.
///
/// Exposed to JavaScript as `NativeModules.BleNativeModule`.
/// Extends `RCTEventEmitter` to support sending events to JS.
@objc(BleNativeModule)
final class BleNativeModule: RCTEventEmitter {

    // MARK: - Sub-Managers

    private let centralManager = BleCentralManager()
    private let peripheralManager = BlePeripheralManager()

    /// Whether `initialize()` has been called.
    private var isInitialized = false

    /// Tracks whether any JS listeners are active. RCTEventEmitter requires
    /// this to avoid sending events when nobody is listening.
    private var hasListeners = false

    // MARK: - RCTEventEmitter Overrides

    /// The module must be initialized on the main queue because CoreBluetooth
    /// managers are created on the main queue.
    override static func requiresMainQueueSetup() -> Bool {
        return true
    }

    /// Return the list of event names this module can emit.
    override func supportedEvents() -> [String] {
        return BleEventName.allCases.map { $0.rawValue }
    }

    /// Called when the first JS listener is added.
    override func startObserving() {
        hasListeners = true
        // Flush any events queued during state restoration.
        StateRestorationHandler.shared.markBridgeReady()
    }

    /// Called when the last JS listener is removed.
    override func stopObserving() {
        hasListeners = false
        StateRestorationHandler.shared.markBridgeNotReady()
    }

    // MARK: - Lifecycle

    /// Initialize the BLE stack (both central and peripheral managers).
    ///
    /// Must be called once from JS before any other method.
    @objc
    func initialize(
        _ resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        if isInitialized {
            resolve(nil)
            return
        }

        centralManager.delegate = self
        peripheralManager.delegate = self

        // Wire up state restoration event delivery.
        StateRestorationHandler.shared.eventHandler = { [weak self] event in
            self?.handleRestoredEvent(event)
        }

        centralManager.initialize()
        peripheralManager.initialize()

        isInitialized = true
        resolve(nil)
    }

    // MARK: - Scanning

    @objc
    func startScanning(
        _ serviceUuid: String,
        resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        guard isInitialized else {
            reject("NOT_INITIALIZED", "BLE module is not initialized. Call initialize() first.", nil)
            return
        }

        let uuid = CBUUID(string: serviceUuid)
        centralManager.startScanning(serviceUuid: uuid)
        resolve(nil)
    }

    @objc
    func stopScanning(
        _ resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        centralManager.stopScanning()
        resolve(nil)
    }

    // MARK: - Advertising

    @objc
    func startAdvertising(
        _ serviceUuid: String,
        localName: String,
        resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        guard isInitialized else {
            reject("NOT_INITIALIZED", "BLE module is not initialized. Call initialize() first.", nil)
            return
        }

        let uuid = CBUUID(string: serviceUuid)

        // Use the local name as the peer ID for the PEER_ID characteristic.
        // In production this would be the cryptographic peer identity, but
        // the JS side controls what value is passed here.
        peripheralManager.startAdvertising(
            serviceUuid: uuid,
            localName: localName,
            peerId: localName
        )
        resolve(nil)
    }

    @objc
    func stopAdvertising(
        _ resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        peripheralManager.stopAdvertising()
        resolve(nil)
    }

    // MARK: - Connection

    @objc
    func connectToPeripheral(
        _ peripheralId: String,
        serviceUuid: String,
        resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        guard isInitialized else {
            reject("NOT_INITIALIZED", "BLE module is not initialized. Call initialize() first.", nil)
            return
        }

        let uuid = CBUUID(string: serviceUuid)
        centralManager.connectToPeripheral(
            peripheralId: peripheralId,
            serviceUuid: uuid,
            resolve: resolve,
            reject: reject
        )
    }

    @objc
    func disconnectPeripheral(
        _ peripheralId: String,
        resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        centralManager.disconnectPeripheral(peripheralId: peripheralId)
        resolve(nil)
    }

    // MARK: - Data Transfer

    @objc
    func writeCharacteristic(
        _ peripheralId: String,
        serviceUuid: String,
        characteristicUuid: String,
        data: String,
        resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        guard isInitialized else {
            reject("NOT_INITIALIZED", "BLE module is not initialized. Call initialize() first.", nil)
            return
        }

        guard let rawData = Data(base64Encoded: data) else {
            reject("INVALID_DATA", "Could not decode base64 data string.", nil)
            return
        }

        let svcUuid = CBUUID(string: serviceUuid)
        let charUuid = CBUUID(string: characteristicUuid)

        centralManager.writeCharacteristic(
            peripheralId: peripheralId,
            serviceUuid: svcUuid,
            characteristicUuid: charUuid,
            data: rawData,
            resolve: resolve,
            reject: reject
        )
    }

    @objc
    func readCharacteristic(
        _ peripheralId: String,
        serviceUuid: String,
        characteristicUuid: String,
        resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        guard isInitialized else {
            reject("NOT_INITIALIZED", "BLE module is not initialized. Call initialize() first.", nil)
            return
        }

        let svcUuid = CBUUID(string: serviceUuid)
        let charUuid = CBUUID(string: characteristicUuid)

        centralManager.readCharacteristic(
            peripheralId: peripheralId,
            serviceUuid: svcUuid,
            characteristicUuid: charUuid,
            resolve: resolve,
            reject: reject
        )
    }

    // MARK: - MTU

    @objc
    func requestMtu(
        _ peripheralId: String,
        mtu: NSNumber,
        resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        // On iOS the MTU is negotiated automatically by CoreBluetooth.
        // We simply return the effective maximum write value length + ATT header.
        guard let effectiveMtu = centralManager.getEffectiveMtu(peripheralId: peripheralId) else {
            // If we can't get the MTU, return the requested MTU as a fallback.
            resolve(mtu.intValue)
            return
        }

        // Return the full MTU (payload + 3 byte ATT header).
        let fullMtu = effectiveMtu + 3
        resolve(fullMtu)
    }

    // MARK: - Connected Peripherals

    @objc
    func getConnectedPeripherals(
        _ serviceUuid: String,
        resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        let uuid = CBUUID(string: serviceUuid)
        let ids = centralManager.getConnectedPeripherals(serviceUuid: uuid)
        resolve(ids)
    }

    // MARK: - Private: Event Emission

    /// Safely emit an event to JS. No-ops if no listeners are active.
    private func emitEvent(_ name: BleEventName, body: [String: Any]) {
        guard hasListeners else { return }
        sendEvent(withName: name.rawValue, body: body)
    }

    /// Convert a CBManagerState to a string representation for JS.
    private func bleStateString(from state: CBManagerState) -> String {
        switch state {
        case .unknown:       return "unknown"
        case .resetting:     return "resetting"
        case .unsupported:   return "unsupported"
        case .unauthorized:  return "unauthorized"
        case .poweredOff:    return "poweredOff"
        case .poweredOn:     return "poweredOn"
        @unknown default:    return "unknown"
        }
    }

    /// Handle an event that was queued during state restoration.
    private func handleRestoredEvent(_ event: QueuedBleEvent) {
        switch event {
        case .dataReceived(let peerId, let data):
            emitEvent(.dataReceived, body: [
                "peerId": peerId,
                "data": data
            ])

        case .connectionStateChanged(let peerId, let state):
            emitEvent(.connectionStateChanged, body: [
                "peerId": peerId,
                "state": state
            ])

        case .peerDiscovered(let peerId, let name, let rssi):
            emitEvent(.peerDiscovered, body: [
                "peerId": peerId,
                "displayName": name,
                "rssi": rssi
            ])
        }
    }
}

// MARK: - BleCentralManagerDelegate

extension BleNativeModule: BleCentralManagerDelegate {

    func centralManagerDidUpdateBleState(_ state: CBManagerState) {
        emitEvent(.bleStateChanged, body: [
            "state": bleStateString(from: state)
        ])
    }

    func centralManagerDidDiscoverPeer(
        peripheralId: String,
        name: String,
        rssi: NSNumber
    ) {
        emitEvent(.peerDiscovered, body: [
            "peerId": peripheralId,
            "displayName": name,
            "rssi": rssi
        ])
    }

    func centralManagerDidConnectPeer(peripheralId: String) {
        emitEvent(.connectionStateChanged, body: [
            "peerId": peripheralId,
            "state": "connected"
        ])
    }

    func centralManagerDidDisconnectPeer(peripheralId: String, error: Error?) {
        emitEvent(.connectionStateChanged, body: [
            "peerId": peripheralId,
            "state": "disconnected"
        ])
    }

    func centralManagerDidFailToConnectPeer(peripheralId: String, error: Error?) {
        emitEvent(.connectionStateChanged, body: [
            "peerId": peripheralId,
            "state": "disconnected"
        ])
    }

    func centralManagerDidReceiveData(peripheralId: String, data: Data) {
        let base64 = data.base64EncodedString()
        emitEvent(.dataReceived, body: [
            "peerId": peripheralId,
            "data": base64
        ])
    }

    func centralManagerDidReadPeerId(peripheralId: String, peerId: String) {
        // The peer ID read is informational; the JS side reads it
        // explicitly via readCharacteristic when needed.
        // We could emit an event here if desired, but the current JS
        // API uses the promise-based readCharacteristic approach.
    }

    func centralManagerDidUpdateMtu(peripheralId: String, mtu: Int) {
        emitEvent(.mtuChanged, body: [
            "peerId": peripheralId,
            "mtu": mtu
        ])
    }
}

// MARK: - BlePeripheralManagerDelegate

extension BleNativeModule: BlePeripheralManagerDelegate {

    func peripheralManagerDidUpdateBleState(_ state: CBManagerState) {
        // Both central and peripheral can report state; emit on every change.
        emitEvent(.bleStateChanged, body: [
            "state": bleStateString(from: state)
        ])
    }

    func peripheralManagerDidReceiveData(fromCentral centralId: String, data: Data) {
        let base64 = data.base64EncodedString()
        emitEvent(.dataReceived, body: [
            "peerId": centralId,
            "data": base64
        ])
    }

    func peripheralManagerDidSubscribeCentral(_ centralId: String) {
        emitEvent(.connectionStateChanged, body: [
            "peerId": centralId,
            "state": "connected"
        ])
    }

    func peripheralManagerDidUnsubscribeCentral(_ centralId: String) {
        emitEvent(.connectionStateChanged, body: [
            "peerId": centralId,
            "state": "disconnected"
        ])
    }
}
