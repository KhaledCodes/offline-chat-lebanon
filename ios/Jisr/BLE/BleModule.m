//
//  BleModule.m
//  Jisr
//
//  Objective-C bridge declarations that expose the Swift BleNativeModule
//  class and its methods to React Native's bridge. React Native discovers
//  native modules through these RCT_EXTERN macros.
//

#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(BleNativeModule, RCTEventEmitter)

// -- Lifecycle ----------------------------------------------------------------

RCT_EXTERN_METHOD(initialize:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// -- Scanning -----------------------------------------------------------------

RCT_EXTERN_METHOD(startScanning:(NSString *)serviceUuid
                  resolve:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(stopScanning:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// -- Advertising --------------------------------------------------------------

RCT_EXTERN_METHOD(startAdvertising:(NSString *)serviceUuid
                  localName:(NSString *)localName
                  resolve:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(stopAdvertising:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// -- Connection ---------------------------------------------------------------

RCT_EXTERN_METHOD(connectToPeripheral:(NSString *)peripheralId
                  serviceUuid:(NSString *)serviceUuid
                  resolve:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(disconnectPeripheral:(NSString *)peripheralId
                  resolve:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// -- Data Transfer ------------------------------------------------------------

RCT_EXTERN_METHOD(writeCharacteristic:(NSString *)peripheralId
                  serviceUuid:(NSString *)serviceUuid
                  characteristicUuid:(NSString *)characteristicUuid
                  data:(NSString *)data
                  resolve:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(readCharacteristic:(NSString *)peripheralId
                  serviceUuid:(NSString *)serviceUuid
                  characteristicUuid:(NSString *)characteristicUuid
                  resolve:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// -- MTU ----------------------------------------------------------------------

RCT_EXTERN_METHOD(requestMtu:(NSString *)peripheralId
                  mtu:(nonnull NSNumber *)mtu
                  resolve:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// -- Connected Peripherals ----------------------------------------------------

RCT_EXTERN_METHOD(getConnectedPeripherals:(NSString *)serviceUuid
                  resolve:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
