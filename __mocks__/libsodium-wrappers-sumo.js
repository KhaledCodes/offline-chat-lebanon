// Mock libsodium-wrappers-sumo for Jest
// KeyManager tests that need real crypto should use @noble/* directly
const sodium = {
  ready: Promise.resolve(),
  crypto_sign_seed_keypair: (seed) => {
    // Return dummy keypair for tests that don't need real crypto
    return {
      publicKey: new Uint8Array(32).fill(1),
      privateKey: new Uint8Array(64).fill(2),
    };
  },
  crypto_sign_ed25519_pk_to_curve25519: (pk) => new Uint8Array(32).fill(3),
  crypto_sign_ed25519_sk_to_curve25519: (sk) => new Uint8Array(32).fill(4),
};

module.exports = sodium;
module.exports.default = sodium;
