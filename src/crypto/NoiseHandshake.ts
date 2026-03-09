/**
 * NoiseHandshake.ts - Noise XX handshake state machine for Jisr.
 *
 * Implements the Noise_XX_25519_ChaChaPoly_BLAKE2b interactive handshake
 * pattern.  The XX pattern exchanges both parties' static keys within the
 * handshake (encrypted after the first round-trip) and provides mutual
 * authentication + forward secrecy.
 *
 * Message flow (XX pattern):
 *   -> e                        (initiator sends ephemeral)
 *   <- e, ee, s, es             (responder sends ephemeral + static)
 *   -> s, se                    (initiator sends static)
 *
 * After three messages both sides derive symmetric send/receive keys.
 *
 * Dependencies:
 *   - @noble/ciphers   (ChaCha20-Poly1305 AEAD)
 *   - @noble/hashes    (BLAKE2b hash, HKDF)
 *   - @noble/curves    (X25519 DH)
 */

import { x25519 } from '@noble/curves/ed25519';
import { blake2b } from '@noble/hashes/blake2';
import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { randomBytes } from '@noble/hashes/utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Symmetric session keys produced when the handshake completes. */
export interface NoiseSessionKeys {
  /** ChaChaPoly key for encrypting outgoing messages (32 bytes). */
  sendKey: Uint8Array;
  /** ChaChaPoly key for decrypting incoming messages (32 bytes). */
  receiveKey: Uint8Array;
  /** Initial send nonce counter (starts at 0). */
  sendNonce: number;
  /** Initial receive nonce counter (starts at 0). */
  receiveNonce: number;
  /** Remote party's static X25519 public key (32 bytes). */
  remotePublicKey: Uint8Array;
}

/** Internal state names. */
export type HandshakeState =
  | 'IDLE'
  | 'MSG1_SENT'
  | 'MSG1_RECEIVED'
  | 'MSG2_SENT'
  | 'MSG2_RECEIVED'
  | 'COMPLETE'
  | 'ABORTED';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DH_LEN = 32; // X25519 key length
const MAC_LEN = 16; // Poly1305 tag
const HASH_LEN = 64; // BLAKE2b-512

const PROTOCOL_NAME = 'Noise_XX_25519_ChaChaPoly_BLAKE2b';

// ---------------------------------------------------------------------------
// Low-level crypto helpers using @noble libraries
// ---------------------------------------------------------------------------

function generateKeypair(): { publicKey: Uint8Array; secretKey: Uint8Array } {
  const secretKey = randomBytes(32);
  const publicKey = x25519.getPublicKey(secretKey);
  return { publicKey, secretKey };
}

/** X25519 scalar multiplication (Diffie-Hellman). */
function dh(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(secretKey, publicKey);
}

/** BLAKE2b-512 hash. */
function hash(data: Uint8Array): Uint8Array {
  return blake2b(data, { dkLen: HASH_LEN });
}

/** BLAKE2b keyed hash (used as HMAC replacement in Noise HKDF). */
function hmacBlake2b(key: Uint8Array, data: Uint8Array): Uint8Array {
  return blake2b(data, { key, dkLen: HASH_LEN });
}

/**
 * HKDF as defined by the Noise spec using BLAKE2b:
 *   HKDF(chaining_key, input_key_material) -> (ck, k) or (ck, k1, k2)
 */
function hkdf(
  chainingKey: Uint8Array,
  inputKeyMaterial: Uint8Array,
  numOutputs: 2,
): [Uint8Array, Uint8Array];
function hkdf(
  chainingKey: Uint8Array,
  inputKeyMaterial: Uint8Array,
  numOutputs: 3,
): [Uint8Array, Uint8Array, Uint8Array];
function hkdf(
  chainingKey: Uint8Array,
  inputKeyMaterial: Uint8Array,
  numOutputs: 2 | 3,
): Uint8Array[] {
  const tempKey = hmacBlake2b(chainingKey, inputKeyMaterial);
  const out1 = hmacBlake2b(tempKey, new Uint8Array([0x01]));
  const out2Buf = new Uint8Array(out1.length + 1);
  out2Buf.set(out1);
  out2Buf[out1.length] = 0x02;
  const out2 = hmacBlake2b(tempKey, out2Buf);

  if (numOutputs === 2) {
    return [out1.slice(0, 32), out2.slice(0, 32)];
  }

  const out3Buf = new Uint8Array(out2.length + 1);
  out3Buf.set(out2);
  out3Buf[out2.length] = 0x03;
  const out3 = hmacBlake2b(tempKey, out3Buf);
  return [out1.slice(0, 32), out2.slice(0, 32), out3.slice(0, 32)];
}

/** Encrypt with ChaChaPoly-IETF. */
function encryptAEAD(
  key: Uint8Array,
  nonce: bigint,
  ad: Uint8Array,
  plaintext: Uint8Array,
): Uint8Array {
  // Build 12-byte IETF nonce: 4 zero bytes + 8 byte LE counter
  const nonceBuf = new Uint8Array(12);
  const view = new DataView(nonceBuf.buffer);
  view.setUint32(4, Number(nonce & 0xFFFFFFFFn), true);
  view.setUint32(8, Number((nonce >> 32n) & 0xFFFFFFFFn), true);

  const cipher = chacha20poly1305(key, nonceBuf, ad.length > 0 ? ad : undefined);
  return cipher.encrypt(plaintext);
}

/** Decrypt with ChaChaPoly-IETF. Throws on authentication failure. */
function decryptAEAD(
  key: Uint8Array,
  nonce: bigint,
  ad: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array {
  const nonceBuf = new Uint8Array(12);
  const view = new DataView(nonceBuf.buffer);
  view.setUint32(4, Number(nonce & 0xFFFFFFFFn), true);
  view.setUint32(8, Number((nonce >> 32n) & 0xFFFFFFFFn), true);

  const cipher = chacha20poly1305(key, nonceBuf, ad.length > 0 ? ad : undefined);
  return cipher.decrypt(ciphertext);
}

// ---------------------------------------------------------------------------
// CipherState (per the Noise specification)
// ---------------------------------------------------------------------------

class CipherState {
  private k: Uint8Array | null = null;
  private n: bigint = 0n;

  initializeKey(key: Uint8Array | null): void {
    this.k = key;
    this.n = 0n;
  }

  hasKey(): boolean {
    return this.k !== null;
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (!this.k) {
      return plaintext;
    }
    const ct = encryptAEAD(this.k, this.n, ad, plaintext);
    this.n += 1n;
    return ct;
  }

  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (!this.k) {
      return ciphertext;
    }
    const pt = decryptAEAD(this.k, this.n, ad, ciphertext);
    this.n += 1n;
    return pt;
  }

  getKey(): Uint8Array | null {
    return this.k ? new Uint8Array(this.k) : null;
  }

  getNonce(): bigint {
    return this.n;
  }
}

// ---------------------------------------------------------------------------
// SymmetricState
// ---------------------------------------------------------------------------

class SymmetricState {
  private ck: Uint8Array; // chaining key
  private h: Uint8Array; // handshake hash
  private cipher: CipherState;

  constructor() {
    this.ck = new Uint8Array(32);
    this.h = new Uint8Array(HASH_LEN);
    this.cipher = new CipherState();
  }

  initializeSymmetric(protocolName: string): void {
    const nameBytes = new TextEncoder().encode(protocolName);
    if (nameBytes.length <= HASH_LEN) {
      const padded = new Uint8Array(HASH_LEN);
      padded.set(nameBytes);
      this.h = padded;
    } else {
      this.h = hash(nameBytes);
    }
    this.ck = this.h.slice(0, 32);
    this.cipher.initializeKey(null);
  }

  mixKey(inputKeyMaterial: Uint8Array): void {
    const [ck, tempK] = hkdf(this.ck, inputKeyMaterial, 2);
    this.ck = ck;
    this.cipher.initializeKey(tempK);
  }

  mixHash(data: Uint8Array): void {
    const combined = new Uint8Array(this.h.length + data.length);
    combined.set(this.h);
    combined.set(data, this.h.length);
    this.h = hash(combined);
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ct = this.cipher.encryptWithAd(this.h, plaintext);
    this.mixHash(ct);
    return ct;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const pt = this.cipher.decryptWithAd(this.h, ciphertext);
    this.mixHash(ciphertext);
    return pt;
  }

  split(): [CipherState, CipherState] {
    const [tempK1, tempK2] = hkdf(this.ck, new Uint8Array(0), 2);
    const c1 = new CipherState();
    c1.initializeKey(tempK1);
    const c2 = new CipherState();
    c2.initializeKey(tempK2);
    return [c1, c2];
  }

  getHandshakeHash(): Uint8Array {
    return new Uint8Array(this.h);
  }
}

// ---------------------------------------------------------------------------
// NoiseHandshake
// ---------------------------------------------------------------------------

export class NoiseHandshake {
  private state: HandshakeState = 'IDLE';
  private initiator = false;

  private localStaticPublic: Uint8Array | null = null;
  private localStaticSecret: Uint8Array | null = null;
  private localEphemeralPublic: Uint8Array | null = null;
  private localEphemeralSecret: Uint8Array | null = null;
  private remoteStaticPublic: Uint8Array | null = null;
  private remoteEphemeralPublic: Uint8Array | null = null;

  private symmetric: SymmetricState = new SymmetricState();
  private sendCipher: CipherState | null = null;
  private recvCipher: CipherState | null = null;

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  initiateHandshake(
    localStaticKey: { publicKey: Uint8Array; secretKey: Uint8Array },
    _remoteStaticKey?: Uint8Array,
  ): Uint8Array {
    if (this.state !== 'IDLE') {
      throw new Error(`Cannot initiate handshake from state ${this.state}`);
    }

    this.initiator = true;
    this.localStaticPublic = localStaticKey.publicKey;
    this.localStaticSecret = localStaticKey.secretKey;

    const eph = generateKeypair();
    this.localEphemeralPublic = eph.publicKey;
    this.localEphemeralSecret = eph.secretKey;

    this.symmetric.initializeSymmetric(PROTOCOL_NAME);
    this.symmetric.mixHash(new Uint8Array(0));

    // --- XX msg1: -> e ---
    this.symmetric.mixHash(this.localEphemeralPublic);
    const payloadCt = this.symmetric.encryptAndHash(new Uint8Array(0));

    const msg1 = new Uint8Array(
      this.localEphemeralPublic.length + payloadCt.length,
    );
    msg1.set(this.localEphemeralPublic);
    msg1.set(payloadCt, this.localEphemeralPublic.length);

    this.state = 'MSG1_SENT';
    return msg1;
  }

  private initializeResponder(
    localStaticKey: { publicKey: Uint8Array; secretKey: Uint8Array },
  ): void {
    this.initiator = false;
    this.localStaticPublic = localStaticKey.publicKey;
    this.localStaticSecret = localStaticKey.secretKey;

    const eph = generateKeypair();
    this.localEphemeralPublic = eph.publicKey;
    this.localEphemeralSecret = eph.secretKey;

    this.symmetric.initializeSymmetric(PROTOCOL_NAME);
    this.symmetric.mixHash(new Uint8Array(0));
  }

  handleMessage(
    message: Uint8Array,
    localStaticKey?: { publicKey: Uint8Array; secretKey: Uint8Array },
  ): {
    response?: Uint8Array;
    complete: boolean;
    session?: NoiseSessionKeys;
  } {
    switch (this.state) {
      case 'IDLE': {
        if (!localStaticKey) {
          throw new Error(
            'localStaticKey must be provided when handling msg1 as responder',
          );
        }

        this.initializeResponder(localStaticKey);

        const re = message.slice(0, DH_LEN);
        this.remoteEphemeralPublic = re;
        this.symmetric.mixHash(re);

        const payloadCt = message.slice(DH_LEN);
        this.symmetric.decryptAndHash(payloadCt);

        this.state = 'MSG1_RECEIVED';

        const msg2 = this.buildMsg2();
        this.state = 'MSG2_SENT';
        return { response: msg2, complete: false };
      }

      case 'MSG1_SENT': {
        this.processMsg2(message);
        this.state = 'MSG2_RECEIVED';

        const msg3 = this.buildMsg3();
        this.state = 'COMPLETE';

        const session = this.deriveSessionKeys();
        return { response: msg3, complete: true, session };
      }

      case 'MSG2_SENT': {
        this.processMsg3(message);
        this.state = 'COMPLETE';

        const session = this.deriveSessionKeys();
        return { complete: true, session };
      }

      default:
        throw new Error(`Unexpected message in state ${this.state}`);
    }
  }

  getRemotePublicKey(): Uint8Array | null {
    return this.remoteStaticPublic ? new Uint8Array(this.remoteStaticPublic) : null;
  }

  isComplete(): boolean {
    return this.state === 'COMPLETE';
  }

  abort(): void {
    this.state = 'ABORTED';
    this.localStaticSecret = null;
    this.localEphemeralSecret = null;
    this.sendCipher = null;
    this.recvCipher = null;
  }

  getState(): HandshakeState {
    return this.state;
  }

  // -----------------------------------------------------------------------
  // Message builders
  // -----------------------------------------------------------------------

  private buildMsg2(): Uint8Array {
    this.symmetric.mixHash(this.localEphemeralPublic!);

    const ee = dh(this.localEphemeralSecret!, this.remoteEphemeralPublic!);
    this.symmetric.mixKey(ee);

    const encryptedS = this.symmetric.encryptAndHash(this.localStaticPublic!);

    const es = dh(this.localStaticSecret!, this.remoteEphemeralPublic!);
    this.symmetric.mixKey(es);

    const payloadCt = this.symmetric.encryptAndHash(new Uint8Array(0));

    const msg2 = new Uint8Array(
      DH_LEN + encryptedS.length + payloadCt.length,
    );
    let offset = 0;
    msg2.set(this.localEphemeralPublic!, offset);
    offset += DH_LEN;
    msg2.set(encryptedS, offset);
    offset += encryptedS.length;
    msg2.set(payloadCt, offset);

    return msg2;
  }

  private processMsg2(msg: Uint8Array): void {
    let offset = 0;

    const re = msg.slice(offset, offset + DH_LEN);
    this.remoteEphemeralPublic = re;
    this.symmetric.mixHash(re);
    offset += DH_LEN;

    const ee = dh(this.localEphemeralSecret!, this.remoteEphemeralPublic);
    this.symmetric.mixKey(ee);

    const encryptedS = msg.slice(offset, offset + DH_LEN + MAC_LEN);
    const rs = this.symmetric.decryptAndHash(encryptedS);
    this.remoteStaticPublic = rs;
    offset += DH_LEN + MAC_LEN;

    const es = dh(this.localEphemeralSecret!, this.remoteStaticPublic);
    this.symmetric.mixKey(es);

    const payloadCt = msg.slice(offset);
    this.symmetric.decryptAndHash(payloadCt);
  }

  private buildMsg3(): Uint8Array {
    const encryptedS = this.symmetric.encryptAndHash(this.localStaticPublic!);

    const se = dh(this.localStaticSecret!, this.remoteEphemeralPublic!);
    this.symmetric.mixKey(se);

    const payloadCt = this.symmetric.encryptAndHash(new Uint8Array(0));

    const msg3 = new Uint8Array(encryptedS.length + payloadCt.length);
    msg3.set(encryptedS);
    msg3.set(payloadCt, encryptedS.length);

    return msg3;
  }

  private processMsg3(msg: Uint8Array): void {
    let offset = 0;

    const encryptedS = msg.slice(offset, offset + DH_LEN + MAC_LEN);
    const rs = this.symmetric.decryptAndHash(encryptedS);
    this.remoteStaticPublic = rs;
    offset += DH_LEN + MAC_LEN;

    const se = dh(this.localEphemeralSecret!, this.remoteStaticPublic);
    this.symmetric.mixKey(se);

    const payloadCt = msg.slice(offset);
    this.symmetric.decryptAndHash(payloadCt);
  }

  // -----------------------------------------------------------------------
  // Key derivation
  // -----------------------------------------------------------------------

  private deriveSessionKeys(): NoiseSessionKeys {
    const [c1, c2] = this.symmetric.split();
    this.sendCipher = this.initiator ? c1 : c2;
    this.recvCipher = this.initiator ? c2 : c1;

    const sendKey = this.sendCipher.getKey();
    const recvKey = this.recvCipher.getKey();

    if (!sendKey || !recvKey || !this.remoteStaticPublic) {
      throw new Error('Failed to derive session keys');
    }

    return {
      sendKey,
      receiveKey: recvKey,
      sendNonce: 0,
      receiveNonce: 0,
      remotePublicKey: new Uint8Array(this.remoteStaticPublic),
    };
  }
}
