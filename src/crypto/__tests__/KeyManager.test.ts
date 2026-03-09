/**
 * KeyManager.test.ts - Unit tests for KeyManager's pure functions.
 *
 * Focuses on parseContactQR which does not require initialize().
 * The libsodium dependency is mocked (see __mocks__/libsodium-wrappers-sumo.js),
 * so we avoid testing initialize() or methods that depend on it.
 *
 * Runs on Node.js -- no device or emulator needed.
 */

import { KeyManager, toBase64Url, fromBase64Url } from '../KeyManager';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a valid jisr:// contact URI from a 32-byte public key and name.
 */
function buildContactUri(pubKeyBytes: Uint8Array, name: string): string {
  const pub = toBase64Url(pubKeyBytes);
  return `jisr://contact?pub=${pub}&name=${encodeURIComponent(name)}&v=1`;
}

/** Generate a deterministic 32-byte "key" for testing (not cryptographically random). */
function fakeKey(fill: number = 0xAB): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('KeyManager', () => {
  let km: KeyManager;

  beforeEach(() => {
    // Create a fresh, un-initialized KeyManager instance for each test.
    // parseContactQR does NOT require initialize().
    km = new KeyManager();
  });

  // -------------------------------------------------------------------------
  // parseContactQR - valid URIs
  // -------------------------------------------------------------------------

  describe('parseContactQR with valid URI', () => {
    it('should parse a well-formed jisr:// contact URI', () => {
      const pubKey = fakeKey(0xAA);
      const name = 'Alice';
      const uri = buildContactUri(pubKey, name);

      const result = km.parseContactQR(uri);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('Alice');
      expect(result!.pubKey.length).toBe(32);

      // Verify the public key bytes match
      for (let i = 0; i < 32; i++) {
        expect(result!.pubKey[i]).toBe(pubKey[i]);
      }
    });

    it('should return correct pubKey bytes for a known base64url value', () => {
      // 32 zero bytes -> base64url = AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
      const zeroPub = new Uint8Array(32);
      const uri = buildContactUri(zeroPub, 'Zero');

      const result = km.parseContactQR(uri);
      expect(result).not.toBeNull();
      expect(result!.pubKey.length).toBe(32);
      for (let i = 0; i < 32; i++) {
        expect(result!.pubKey[i]).toBe(0);
      }
    });

    it('should handle an empty name', () => {
      const pubKey = fakeKey(0xBB);
      const uri = buildContactUri(pubKey, '');

      const result = km.parseContactQR(uri);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('');
    });

    it('should handle a missing name parameter (defaults to empty string)', () => {
      const pub = toBase64Url(fakeKey(0xCC));
      const uri = `jisr://contact?pub=${pub}&v=1`;

      const result = km.parseContactQR(uri);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // parseContactQR - URL-encoded names
  // -------------------------------------------------------------------------

  describe('parseContactQR with URL-encoded name', () => {
    it('should decode URL-encoded special characters in name', () => {
      const pubKey = fakeKey(0xDD);
      const name = 'John & Jane';
      const uri = buildContactUri(pubKey, name);

      const result = km.parseContactQR(uri);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('John & Jane');
    });

    it('should decode Unicode characters in name', () => {
      const pubKey = fakeKey(0xEE);
      const name = 'Sami'; // Arabic characters could be tested too
      const uri = buildContactUri(pubKey, name);

      const result = km.parseContactQR(uri);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('Sami');
    });

    it('should handle spaces encoded as + or %20', () => {
      const pub = toBase64Url(fakeKey(0x11));
      // URLSearchParams decodes '+' as space
      const uri = `jisr://contact?pub=${pub}&name=Hello+World&v=1`;

      const result = km.parseContactQR(uri);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('Hello World');
    });

    it('should handle name with equals signs and other special chars', () => {
      const pubKey = fakeKey(0x22);
      const name = 'key=value&other=stuff';
      const uri = buildContactUri(pubKey, name);

      const result = km.parseContactQR(uri);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('key=value&other=stuff');
    });
  });

  // -------------------------------------------------------------------------
  // parseContactQR - invalid URIs
  // -------------------------------------------------------------------------

  describe('parseContactQR with invalid URIs', () => {
    it('should return null for wrong scheme (https://)', () => {
      const pub = toBase64Url(fakeKey());
      const uri = `https://contact?pub=${pub}&name=Alice&v=1`;
      expect(km.parseContactQR(uri)).toBeNull();
    });

    it('should return null for wrong scheme (signal://)', () => {
      const pub = toBase64Url(fakeKey());
      const uri = `signal://contact?pub=${pub}&name=Alice&v=1`;
      expect(km.parseContactQR(uri)).toBeNull();
    });

    it('should return null for missing pub parameter', () => {
      const uri = 'jisr://contact?name=Alice&v=1';
      expect(km.parseContactQR(uri)).toBeNull();
    });

    it('should return null for wrong version (v=2)', () => {
      const pub = toBase64Url(fakeKey());
      const uri = `jisr://contact?pub=${pub}&name=Alice&v=2`;
      expect(km.parseContactQR(uri)).toBeNull();
    });

    it('should return null for missing version', () => {
      const pub = toBase64Url(fakeKey());
      const uri = `jisr://contact?pub=${pub}&name=Alice`;
      expect(km.parseContactQR(uri)).toBeNull();
    });

    it('should return null for wrong key length (too short)', () => {
      // 16 bytes instead of 32
      const shortKey = toBase64Url(new Uint8Array(16).fill(0xFF));
      const uri = `jisr://contact?pub=${shortKey}&name=Alice&v=1`;
      expect(km.parseContactQR(uri)).toBeNull();
    });

    it('should return null for wrong key length (too long)', () => {
      // 64 bytes instead of 32
      const longKey = toBase64Url(new Uint8Array(64).fill(0xFF));
      const uri = `jisr://contact?pub=${longKey}&name=Alice&v=1`;
      expect(km.parseContactQR(uri)).toBeNull();
    });

    it('should return null for empty string', () => {
      expect(km.parseContactQR('')).toBeNull();
    });

    it('should return null for completely unrelated string', () => {
      expect(km.parseContactQR('not a uri at all')).toBeNull();
    });

    it('should return null for jisr:// with no query string', () => {
      expect(km.parseContactQR('jisr://contact')).toBeNull();
    });

    it('should return null for jisr:// with wrong path', () => {
      const pub = toBase64Url(fakeKey());
      const uri = `jisr://settings?pub=${pub}&name=Alice&v=1`;
      expect(km.parseContactQR(uri)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // toBase64Url / fromBase64Url helpers
  // -------------------------------------------------------------------------

  describe('toBase64Url / fromBase64Url', () => {
    it('should round-trip arbitrary bytes', () => {
      const original = new Uint8Array([0, 1, 2, 255, 254, 253, 128, 127]);
      const encoded = toBase64Url(original);
      const decoded = fromBase64Url(encoded);

      expect(decoded.length).toBe(original.length);
      for (let i = 0; i < original.length; i++) {
        expect(decoded[i]).toBe(original[i]);
      }
    });

    it('should produce URL-safe characters (no +, /, or =)', () => {
      // Use bytes that would produce + and / in standard base64
      const tricky = new Uint8Array([251, 255, 254, 253, 63, 62]);
      const encoded = toBase64Url(tricky);

      expect(encoded).not.toContain('+');
      expect(encoded).not.toContain('/');
      expect(encoded).not.toContain('=');
    });

    it('should round-trip a 32-byte key', () => {
      const key = new Uint8Array(32);
      for (let i = 0; i < 32; i++) key[i] = i;

      const encoded = toBase64Url(key);
      const decoded = fromBase64Url(encoded);

      expect(decoded.length).toBe(32);
      for (let i = 0; i < 32; i++) {
        expect(decoded[i]).toBe(i);
      }
    });

    it('should handle empty input', () => {
      const encoded = toBase64Url(new Uint8Array(0));
      expect(encoded).toBe('');
      const decoded = fromBase64Url('');
      expect(decoded.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Uninitialized KeyManager guards
  // -------------------------------------------------------------------------

  describe('uninitialized KeyManager', () => {
    it('getPublicKey should throw before initialization', () => {
      expect(() => km.getPublicKey()).toThrow(/not been initialized/);
    });

    it('getX25519PublicKey should throw before initialization', () => {
      expect(() => km.getX25519PublicKey()).toThrow(/not been initialized/);
    });

    it('getX25519PrivateKey should throw before initialization', () => {
      expect(() => km.getX25519PrivateKey()).toThrow(/not been initialized/);
    });

    it('getIdPrefix should throw before initialization', () => {
      expect(() => km.getIdPrefix()).toThrow(/not been initialized/);
    });

    it('getPublicKeyBase64Url should throw before initialization', () => {
      expect(() => km.getPublicKeyBase64Url()).toThrow(/not been initialized/);
    });

    it('exportContactQR should throw before initialization', () => {
      expect(() => km.exportContactQR()).toThrow(/not been initialized/);
    });

    it('generateSafetyNumber should throw before initialization', () => {
      expect(() => km.generateSafetyNumber(new Uint8Array(32))).toThrow(
        /not been initialized/,
      );
    });
  });
});
