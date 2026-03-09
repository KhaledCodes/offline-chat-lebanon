module.exports = {
  preset: 'react-native',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  transformIgnorePatterns: [
    'node_modules/(?!(@noble|nostr-tools|@react-native|react-native|@react-navigation|libsodium)/)',
  ],
  testMatch: ['**/__tests__/**/*.(ts|tsx|js)', '**/*.(test|spec).(ts|tsx|js)'],
  testPathIgnorePatterns: ['/node_modules/', '/android/', '/ios/'],
  moduleNameMapper: {
    // Native module mocks
    '^react-native-mmkv$': '<rootDir>/__mocks__/react-native-mmkv.js',
    '^@op-engineering/op-sqlite$': '<rootDir>/__mocks__/op-sqlite.js',
    '^react-native$': '<rootDir>/__mocks__/react-native.js',
    '^libsodium-wrappers-sumo$': '<rootDir>/__mocks__/libsodium-wrappers-sumo.js',
    // @noble/* subpath exports (Jest can't resolve package.json "exports" field)
    '^@noble/hashes/sha2$': '<rootDir>/node_modules/@noble/hashes/sha2.js',
    '^@noble/hashes/blake2$': '<rootDir>/node_modules/@noble/hashes/blake2.js',
    '^@noble/hashes/utils$': '<rootDir>/node_modules/@noble/hashes/utils.js',
    '^@noble/curves/ed25519$': '<rootDir>/node_modules/@noble/curves/ed25519.js',
    '^@noble/ciphers/chacha$': '<rootDir>/node_modules/@noble/ciphers/chacha.js',
    '^@noble/ciphers/webcrypto$': '<rootDir>/node_modules/@noble/ciphers/webcrypto.js',
  },
};
