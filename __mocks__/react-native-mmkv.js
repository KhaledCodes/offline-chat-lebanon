// Mock MMKV for Jest - uses a simple in-memory Map
class MMKV {
  constructor() {
    this._store = new Map();
  }
  getString(key) {
    return this._store.get(key);
  }
  set(key, value) {
    this._store.set(key, value);
  }
  delete(key) {
    this._store.delete(key);
  }
  contains(key) {
    return this._store.has(key);
  }
  clearAll() {
    this._store.clear();
  }
}

module.exports = { MMKV };
