/**
 * KeyManager.ts - Ed25519 key generation and encrypted storage for Jisr.
 *
 * Responsibilities:
 *  - Generate an Ed25519 identity keypair on first launch.
 *  - Persist the private key in encrypted MMKV storage.
 *  - Derive X25519 keys from Ed25519 for Noise XX handshakes.
 *  - Compute a 4-byte peer-ID prefix (first 4 bytes of SHA-256 of public key).
 *  - Generate safety numbers for out-of-band verification.
 *  - Encode / decode contact QR codes (jisr:// URI scheme).
 *
 * Crypto:  libsodium-wrappers-sumo (ed25519<->x25519 conversion)
 *          @noble/hashes           (SHA-256)
 *          @noble/ed25519          (key generation)
 * Storage: react-native-mmkv       (encrypted key-value store)
 */

import { MMKV } from 'react-native-mmkv';
import { sha256 } from '@noble/hashes/sha2';
import { ed25519 } from '@noble/curves/ed25519';
import _sodium from 'libsodium-wrappers-sumo';

// ---------------------------------------------------------------------------
// MMKV store (encrypted with a deterministic device-bound key)
// ---------------------------------------------------------------------------

const MMKV_ENCRYPTION_KEY = 'jisr-identity-store-v1';

const storage = new MMKV({
  id: 'jisr-identity',
  encryptionKey: MMKV_ENCRYPTION_KEY,
});

// MMKV key constants
const MMKV_KEY_PRIVATE = 'jisr_ed25519_private';
const MMKV_KEY_PUBLIC = 'jisr_ed25519_public';
const MMKV_KEY_DISPLAY_NAME = 'jisr_display_name';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Standard base64url encoding (RFC 4648 sect. 5, no padding). */
function toBase64Url(bytes: Uint8Array): string {
  const base64 = Buffer.from(bytes).toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode base64url back to bytes. */
function fromBase64Url(encoded: string): Uint8Array {
  let base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

// ---------------------------------------------------------------------------
// KeyManager singleton
// ---------------------------------------------------------------------------

class KeyManager {
  private ed25519PublicKey: Uint8Array | null = null;
  private ed25519PrivateKey: Uint8Array | null = null;
  private x25519PublicKey: Uint8Array | null = null;
  private x25519PrivateKey: Uint8Array | null = null;
  private idPrefix: Uint8Array | null = null;
  private initialized = false;

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Initialize the key manager.
   *
   * If keys already exist in MMKV they are loaded; otherwise a fresh
   * Ed25519 keypair is generated and persisted.  X25519 keys and the
   * peer-ID prefix are derived every time from the Ed25519 material.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Ensure libsodium is ready
    await _sodium.ready;
    const sodium = _sodium;

    const storedPrivate = storage.getString(MMKV_KEY_PRIVATE);
    const storedPublic = storage.getString(MMKV_KEY_PUBLIC);

    if (storedPrivate && storedPublic) {
      this.ed25519PrivateKey = fromBase64Url(storedPrivate);
      this.ed25519PublicKey = fromBase64Url(storedPublic);
    } else {
      // First launch -- generate a new keypair using @noble/ed25519
      this.ed25519PrivateKey = ed25519.utils.randomPrivateKey();
      this.ed25519PublicKey = ed25519.getPublicKey(this.ed25519PrivateKey);

      // Persist (base64url encoded)
      storage.set(MMKV_KEY_PUBLIC, toBase64Url(this.ed25519PublicKey));
      storage.set(MMKV_KEY_PRIVATE, toBase64Url(this.ed25519PrivateKey));
    }

    // Derive X25519 keys from the Ed25519 material using libsodium
    // We need the full 64-byte ed25519 secret key for sodium's conversion
    // @noble/ed25519 private key is 32 bytes (seed), sodium needs 64-byte expanded
    const sodiumKeypair = sodium.crypto_sign_seed_keypair(this.ed25519PrivateKey);

    this.x25519PublicKey = sodium.crypto_sign_ed25519_pk_to_curve25519(
      sodiumKeypair.publicKey,
    );
    this.x25519PrivateKey = sodium.crypto_sign_ed25519_sk_to_curve25519(
      sodiumKeypair.privateKey,
    );

    // Compute 4-byte peer ID prefix = SHA-256(ed25519_pk)[0..4]
    const hash = sha256(this.ed25519PublicKey);
    this.idPrefix = hash.slice(0, 4);

    this.initialized = true;
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  /** Ed25519 public key (32 bytes). */
  getPublicKey(): Uint8Array {
    this.assertInitialized();
    return this.ed25519PublicKey!;
  }

  /** X25519 public key derived from the Ed25519 identity key (32 bytes). */
  getX25519PublicKey(): Uint8Array {
    this.assertInitialized();
    return this.x25519PublicKey!;
  }

  /** X25519 secret key derived from the Ed25519 identity key (32 bytes). */
  getX25519PrivateKey(): Uint8Array {
    this.assertInitialized();
    return this.x25519PrivateKey!;
  }

  /** 4-byte peer ID prefix (first 4 bytes of SHA-256(ed25519_pk)). */
  getIdPrefix(): Uint8Array {
    this.assertInitialized();
    return this.idPrefix!;
  }

  /** Ed25519 public key encoded as URL-safe base64 (no padding). */
  getPublicKeyBase64Url(): string {
    this.assertInitialized();
    return toBase64Url(this.ed25519PublicKey!);
  }

  // -------------------------------------------------------------------------
  // Display name
  // -------------------------------------------------------------------------

  getDisplayName(): string | null {
    return storage.getString(MMKV_KEY_DISPLAY_NAME) ?? null;
  }

  setDisplayName(name: string): void {
    storage.set(MMKV_KEY_DISPLAY_NAME, name);
  }

  // -------------------------------------------------------------------------
  // Safety numbers
  // -------------------------------------------------------------------------

  /**
   * Generate a human-readable safety number for verifying a peer's identity.
   *
   * Algorithm:
   *  1. Concatenate the two Ed25519 public keys in sorted order.
   *  2. SHA-256 the concatenation.
   *  3. Interpret 30 bytes of the hash as 6 groups of 5 decimal digits.
   */
  generateSafetyNumber(theirPubKey: Uint8Array): string {
    this.assertInitialized();

    const ours = this.ed25519PublicKey!;
    const theirs = theirPubKey;

    const cmp = bufferCompare(ours, theirs);
    const first = cmp <= 0 ? ours : theirs;
    const second = cmp <= 0 ? theirs : ours;

    const combined = new Uint8Array(first.length + second.length);
    combined.set(first, 0);
    combined.set(second, first.length);

    const hash = sha256(combined);

    const groups: string[] = [];
    for (let i = 0; i < 6; i++) {
      const offset = i * 5;
      const value =
        (hash[offset] << 24 |
          hash[offset + 1] << 16 |
          hash[offset + 2] << 8 |
          hash[offset + 3]) >>> 0;
      const mixed = (value ^ (hash[offset + 4] << 16)) >>> 0;
      const digits = (mixed % 100000).toString().padStart(5, '0');
      groups.push(digits);
    }

    return groups.join(' ');
  }

  // -------------------------------------------------------------------------
  // QR code helpers
  // -------------------------------------------------------------------------

  exportContactQR(): string {
    this.assertInitialized();
    const pub = this.getPublicKeyBase64Url();
    const name = this.getDisplayName() ?? '';
    return `jisr://contact?pub=${pub}&name=${encodeURIComponent(name)}&v=1`;
  }

  parseContactQR(uri: string): { pubKey: Uint8Array; name: string } | null {
    try {
      if (!uri.startsWith('jisr://contact')) {
        return null;
      }

      const queryStart = uri.indexOf('?');
      if (queryStart === -1) {
        return null;
      }

      const params = new URLSearchParams(uri.slice(queryStart + 1));
      const pubParam = params.get('pub');
      const nameParam = params.get('name');
      const version = params.get('v');

      if (!pubParam || version !== '1') {
        return null;
      }

      const pubKey = fromBase64Url(pubParam);
      if (pubKey.length !== 32) {
        return null;
      }

      return {
        pubKey,
        name: nameParam ?? '',
      };
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        'KeyManager has not been initialized. Call initialize() first.',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function bufferCompare(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) {
      return a[i] - b[i];
    }
  }
  return a.length - b.length;
}

const keyManager = new KeyManager();
export default keyManager;

export { KeyManager, toBase64Url, fromBase64Url };
