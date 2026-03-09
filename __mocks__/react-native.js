// Minimal React Native mock for Jest (non-UI tests only)
module.exports = {
  NativeModules: {},
  NativeEventEmitter: class {
    addListener() { return { remove: () => {} }; }
    removeAllListeners() {}
  },
  I18nManager: { isRTL: false, forceRTL: () => {}, allowRTL: () => {} },
  Platform: { OS: 'ios', select: (obj) => obj.ios },
};
