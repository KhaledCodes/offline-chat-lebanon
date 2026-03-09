/**
 * NoiseSession.ts - Post-handshake encrypted transport for Jisr.
 *
 * Once a Noise XX handshake completes, both peers hold symmetric
 * send / receive keys.  This class wraps those keys and provides a
 * simple encrypt / decrypt API using ChaChaPoly-IETF with an
 * incrementing nonce counter.
 *
 * Wire format of an encrypted message:
 *   [8-byte nonce (LE)] [ciphertext + 16-byte Poly1305 tag]
 *
 * The ChaChaPoly-IETF nonce is 12 bytes: the first 4 bytes are zero,
 * followed by the 8-byte counter in little-endian (matching the Noise
 * spec convention).
 *
 * Serialization:
 *   getSessionBlob() / fromSessionBlob() allow persisting a session to
 *   storage so it can survive app restarts without re-handshaking.
 *
 * Dependencies: @noble/ciphers (ChaCha20-Poly1305)
 */

import { chacha20poly1305 } from '@noble/ciphers/chacha';
import type { NoiseSessionKeys } from './NoiseHandshake';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KEY_LEN = 32;
const NONCE_COUNTER_LEN = 8;
const IETF_NONCE_LEN = 12;
const MAC_LEN = 16;
const REMOTE_PK_LEN = 32;

// Blob layout:
//   [1 byte version] [32 sendKey] [32 receiveKey]
//   [8 sendNonce LE] [8 receiveNonce LE] [32 remotePublicKey]
// Total: 113 bytes
const BLOB_VERSION = 0x01;
const BLOB_LEN = 1 + KEY_LEN + KEY_LEN + 8 + 8 + REMOTE_PK_LEN; // 113

const MAX_NONCE = BigInt('18446744073709551615'); // 2^64 - 1

// ---------------------------------------------------------------------------
// NoiseSession
// ---------------------------------------------------------------------------

export class NoiseSession {
  private sendKey: Uint8Array;
  private receiveKey: Uint8Array;
  private sendNonce: bigint;
  private receiveNonce: bigint;
  private remotePublicKey: Uint8Array;

  constructor(keys: NoiseSessionKeys) {
    if (keys.sendKey.length !== KEY_LEN) {
      throw new Error(`sendKey must be ${KEY_LEN} bytes`);
    }
    if (keys.receiveKey.length !== KEY_LEN) {
      throw new Error(`receiveKey must be ${KEY_LEN} bytes`);
    }
    if (keys.remotePublicKey.length !== REMOTE_PK_LEN) {
      throw new Error(`remotePublicKey must be ${REMOTE_PK_LEN} bytes`);
    }

    this.sendKey = new Uint8Array(keys.sendKey);
    this.receiveKey = new Uint8Array(keys.receiveKey);
    this.sendNonce = BigInt(keys.sendNonce);
    this.receiveNonce = BigInt(keys.receiveNonce);
    this.remotePublicKey = new Uint8Array(keys.remotePublicKey);
  }

  // -----------------------------------------------------------------------
  // Encrypt
  // -----------------------------------------------------------------------

  encrypt(plaintext: Uint8Array): Uint8Array {
    if (this.sendNonce > MAX_NONCE) {
      throw new Error(
        'Send nonce exhausted. The session must be rekeyed or re-established.',
      );
    }

    const nonceCounter = this.sendNonce;
    this.sendNonce += 1n;

    // Build 12-byte IETF nonce: 4 zero bytes + 8 byte LE counter
    const ietfNonce = new Uint8Array(IETF_NONCE_LEN);
    const nonceView = new DataView(ietfNonce.buffer);
    nonceView.setUint32(4, Number(nonceCounter & 0xFFFFFFFFn), true);
    nonceView.setUint32(8, Number((nonceCounter >> 32n) & 0xFFFFFFFFn), true);

    const cipher = chacha20poly1305(this.sendKey, ietfNonce);
    const ciphertext = cipher.encrypt(plaintext);

    // Wire format: [8-byte nonce LE] [ciphertext + tag]
    const noncePrefix = new Uint8Array(NONCE_COUNTER_LEN);
    const prefixView = new DataView(noncePrefix.buffer);
    prefixView.setUint32(0, Number(nonceCounter & 0xFFFFFFFFn), true);
    prefixView.setUint32(4, Number((nonceCounter >> 32n) & 0xFFFFFFFFn), true);

    const wire = new Uint8Array(NONCE_COUNTER_LEN + ciphertext.length);
    wire.set(noncePrefix, 0);
    wire.set(ciphertext, NONCE_COUNTER_LEN);

    return wire;
  }

  // -----------------------------------------------------------------------
  // Decrypt
  // -----------------------------------------------------------------------

  decrypt(wireMessage: Uint8Array): Uint8Array {
    if (wireMessage.length < NONCE_COUNTER_LEN + MAC_LEN) {
      throw new Error(
        `Message too short: expected at least ${NONCE_COUNTER_LEN + MAC_LEN} bytes, got ${wireMessage.length}`,
      );
    }

    // Read the 8-byte LE nonce counter from the wire
    const nonceBytes = wireMessage.slice(0, NONCE_COUNTER_LEN);
    const nonceView = new DataView(nonceBytes.buffer, nonceBytes.byteOffset, nonceBytes.byteLength);
    const lo = nonceView.getUint32(0, true);
    const hi = nonceView.getUint32(4, true);
    const receivedNonce = BigInt(lo) | (BigInt(hi) << 32n);

    // Enforce monotonically increasing nonces (replay protection)
    if (receivedNonce < this.receiveNonce) {
      throw new Error(
        `Nonce replay detected: received ${receivedNonce}, expected >= ${this.receiveNonce}`,
      );
    }

    // Build 12-byte IETF nonce
    const ietfNonce = new Uint8Array(IETF_NONCE_LEN);
    const ietfView = new DataView(ietfNonce.buffer);
    ietfView.setUint32(4, Number(receivedNonce & 0xFFFFFFFFn), true);
    ietfView.setUint32(8, Number((receivedNonce >> 32n) & 0xFFFFFFFFn), true);

    const ciphertext = wireMessage.slice(NONCE_COUNTER_LEN);

    const cipher = chacha20poly1305(this.receiveKey, ietfNonce);
    const plaintext = cipher.decrypt(ciphertext);

    this.receiveNonce = receivedNonce + 1n;

    return plaintext;
  }

  // -----------------------------------------------------------------------
  // Accessors
  // -----------------------------------------------------------------------

  getRemotePublicKey(): Uint8Array {
    return new Uint8Array(this.remotePublicKey);
  }

  getSendNonce(): number {
    return Number(this.sendNonce);
  }

  getReceiveNonce(): number {
    return Number(this.receiveNonce);
  }

  // -----------------------------------------------------------------------
  // Serialization
  // -----------------------------------------------------------------------

  getSessionBlob(): Uint8Array {
    const blob = new Uint8Array(BLOB_LEN);
    const view = new DataView(blob.buffer);
    let offset = 0;

    blob[offset] = BLOB_VERSION;
    offset += 1;

    blob.set(this.sendKey, offset);
    offset += KEY_LEN;

    blob.set(this.receiveKey, offset);
    offset += KEY_LEN;

    // sendNonce as uint64 LE
    view.setUint32(offset, Number(this.sendNonce & 0xFFFFFFFFn), true);
    view.setUint32(offset + 4, Number((this.sendNonce >> 32n) & 0xFFFFFFFFn), true);
    offset += 8;

    // receiveNonce as uint64 LE
    view.setUint32(offset, Number(this.receiveNonce & 0xFFFFFFFFn), true);
    view.setUint32(offset + 4, Number((this.receiveNonce >> 32n) & 0xFFFFFFFFn), true);
    offset += 8;

    blob.set(this.remotePublicKey, offset);

    return blob;
  }

  static fromSessionBlob(blob: Uint8Array): NoiseSession {
    if (blob.length !== BLOB_LEN) {
      throw new Error(
        `Invalid session blob length: expected ${BLOB_LEN}, got ${blob.length}`,
      );
    }

    const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    let offset = 0;

    const version = blob[offset];
    offset += 1;

    if (version !== BLOB_VERSION) {
      throw new Error(
        `Unsupported session blob version: ${version} (expected ${BLOB_VERSION})`,
      );
    }

    const sendKey = blob.slice(offset, offset + KEY_LEN);
    offset += KEY_LEN;

    const receiveKey = blob.slice(offset, offset + KEY_LEN);
    offset += KEY_LEN;

    const sendNonceLo = view.getUint32(offset, true);
    const sendNonceHi = view.getUint32(offset + 4, true);
    const sendNonce = Number(BigInt(sendNonceLo) | (BigInt(sendNonceHi) << 32n));
    offset += 8;

    const recvNonceLo = view.getUint32(offset, true);
    const recvNonceHi = view.getUint32(offset + 4, true);
    const receiveNonce = Number(BigInt(recvNonceLo) | (BigInt(recvNonceHi) << 32n));
    offset += 8;

    const remotePublicKey = blob.slice(offset, offset + REMOTE_PK_LEN);

    return new NoiseSession({
      sendKey,
      receiveKey,
      sendNonce,
      receiveNonce,
      remotePublicKey,
    });
  }
}
