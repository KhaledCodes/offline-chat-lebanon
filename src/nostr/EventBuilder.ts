/**
 * EventBuilder.ts - NIP-17 gift-wrapped direct message builder for Jisr.
 *
 * Implements the three-layer encryption model for private direct messages
 * defined in NIP-17:
 *
 *   Layer 1 (innermost): Kind 14 - The actual DM content
 *     { kind: 14, content: "message", tags: [["p", recipientPubkey]], created_at: timestamp }
 *
 *   Layer 2 (seal):      Kind 13 - Sender's sealed envelope
 *     The kind 14 event is serialised and encrypted with NIP-44 to the
 *     sender's own key, then wrapped in a kind 13 event signed by the sender.
 *
 *   Layer 3 (gift wrap): Kind 1059 - Recipient-addressed wrapper
 *     The kind 13 event is serialised and encrypted with NIP-44 to the
 *     recipient's pubkey, wrapped in a kind 1059 event signed by a random
 *     (disposable) keypair for metadata privacy.
 *
 * This design ensures:
 *   - Only the recipient can unwrap the gift wrap layer.
 *   - The sender's identity is hidden from relay operators.
 *   - Timestamps can be randomised to prevent timing analysis.
 *
 * Dependencies:
 *   - nostr-tools: event serialisation, ID computation, signing
 *   - @noble/ed25519 (via nostr-tools): schnorr signatures
 *
 * TODO: The NIP-44 encryption used here is a simplified placeholder.
 *       Replace with the full nostr-tools nip44 module once available
 *       (requires XChaCha20-Poly1305 with specific padding).
 */

import {
  getPublicKey,
  finalizeEvent,
  serializeEvent,
} from 'nostr-tools/pure';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import type { NostrEvent } from './NostrClient';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of unwrapping a gift-wrapped DM. */
export interface UnwrappedMessage {
  /** The decrypted message content. */
  content: string;
  /** The sender's public key (hex). */
  senderPubkey: string;
  /** Unix timestamp of the original message. */
  timestamp: number;
}

/** Unsigned event structure used during construction. */
interface UnsignedEvent {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
  pubkey?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Kind number for gift wrap (NIP-17). */
const KIND_GIFT_WRAP = 1059;

/** Kind number for seal (NIP-17). */
const KIND_SEAL = 13;

/** Kind number for DM content (NIP-17). */
const KIND_DM = 14;

/**
 * Maximum random offset (in seconds) applied to the gift wrap timestamp
 * to prevent timing correlation. +/- 2 days.
 */
const TIMESTAMP_FUZZ_RANGE_SECONDS = 2 * 24 * 60 * 60;

// ---------------------------------------------------------------------------
// NIP-44 encryption placeholder
// ---------------------------------------------------------------------------

/**
 * TODO: Replace this with the real NIP-44 encryption from nostr-tools.
 *
 * NIP-44 specifies XChaCha20-Poly1305 with a specific padding scheme and
 * HKDF key derivation from the ECDH shared secret. This placeholder uses
 * a simplified approach for development purposes:
 *
 *   1. Compute ECDH shared secret between the sender privkey and recipient pubkey.
 *   2. Derive a symmetric key via SHA-256(shared_secret).
 *   3. XOR the plaintext with a keystream derived from the symmetric key.
 *   4. Prepend a version byte (0x02 for NIP-44 v2 compatibility marker).
 *
 * This is NOT cryptographically equivalent to NIP-44 and MUST be replaced
 * before production use.
 */

// We use the secp256k1 shared secret derivation from nostr-tools/pure.
// In the real implementation this would use nostr-tools/nip44.

/**
 * Compute a shared secret between a private key and a public key using
 * secp256k1 ECDH. Returns a 32-byte Uint8Array.
 */
function computeSharedSecret(
  privkey: Uint8Array,
  pubkeyHex: string,
): Uint8Array {
  // Use the secp256k1 library bundled with nostr-tools.
  // The shared secret for NIP-44 is SHA-256(ECDH(privkey, pubkey)).
  const { getSharedSecret } = require('@noble/secp256k1') as {
    getSharedSecret: (privKey: Uint8Array, pubKey: string) => Uint8Array;
  };

  // secp256k1 getSharedSecret returns the full point; we take the x-coordinate.
  const sharedPoint = getSharedSecret(privkey, '02' + pubkeyHex);
  // x-coordinate is bytes 1..33 of the compressed point output.
  const xCoord = sharedPoint.slice(1, 33);
  return sha256(xCoord);
}

/**
 * Placeholder NIP-44 encrypt.
 *
 * TODO: Replace with `import { encrypt } from 'nostr-tools/nip44'` when
 * the project upgrades to a nostr-tools version that ships the nip44 module
 * with proper XChaCha20-Poly1305 + padding.
 */
function nip44Encrypt(
  plaintext: string,
  senderPrivkey: Uint8Array,
  recipientPubkeyHex: string,
): string {
  const secret = computeSharedSecret(senderPrivkey, recipientPubkeyHex);
  const plaintextBytes = new TextEncoder().encode(plaintext);

  // Generate a random 24-byte nonce.
  const nonce = getRandomBytes(24);

  // Derive a keystream from HMAC(secret, nonce) -- simplified placeholder.
  const keystreamSeed = new Uint8Array(secret.length + nonce.length);
  keystreamSeed.set(secret);
  keystreamSeed.set(nonce, secret.length);
  const keystream = expandKeystream(sha256(keystreamSeed), plaintextBytes.length);

  // XOR plaintext with keystream.
  const ciphertext = new Uint8Array(plaintextBytes.length);
  for (let i = 0; i < plaintextBytes.length; i++) {
    ciphertext[i] = plaintextBytes[i] ^ keystream[i];
  }

  // Pack: version(1) + nonce(24) + ciphertext(N).
  const packed = new Uint8Array(1 + nonce.length + ciphertext.length);
  packed[0] = 0x02; // NIP-44 v2 marker.
  packed.set(nonce, 1);
  packed.set(ciphertext, 1 + nonce.length);

  return uint8ToBase64(packed);
}

/**
 * Placeholder NIP-44 decrypt.
 *
 * TODO: Replace with `import { decrypt } from 'nostr-tools/nip44'`.
 */
function nip44Decrypt(
  ciphertextBase64: string,
  recipientPrivkey: Uint8Array,
  senderPubkeyHex: string,
): string {
  const packed = base64ToUint8(ciphertextBase64);

  if (packed.length < 25) {
    throw new Error('NIP-44 ciphertext too short');
  }

  const version = packed[0];
  if (version !== 0x02) {
    throw new Error(`Unsupported NIP-44 version: ${version}`);
  }

  const nonce = packed.slice(1, 25);
  const ciphertext = packed.slice(25);

  const secret = computeSharedSecret(recipientPrivkey, senderPubkeyHex);

  // Derive keystream with the same method as encrypt.
  const keystreamSeed = new Uint8Array(secret.length + nonce.length);
  keystreamSeed.set(secret);
  keystreamSeed.set(nonce, secret.length);
  const keystream = expandKeystream(sha256(keystreamSeed), ciphertext.length);

  // XOR ciphertext with keystream.
  const plaintext = new Uint8Array(ciphertext.length);
  for (let i = 0; i < ciphertext.length; i++) {
    plaintext[i] = ciphertext[i] ^ keystream[i];
  }

  return new TextDecoder().decode(plaintext);
}

/**
 * Expand a 32-byte seed into a keystream of the desired length by
 * repeatedly hashing with an incrementing counter.
 */
function expandKeystream(seed: Uint8Array, length: number): Uint8Array {
  const result = new Uint8Array(length);
  let offset = 0;
  let counter = 0;

  while (offset < length) {
    const counterBytes = new Uint8Array(4);
    new DataView(counterBytes.buffer).setUint32(0, counter, false);

    const input = new Uint8Array(seed.length + 4);
    input.set(seed);
    input.set(counterBytes, seed.length);

    const block = sha256(input);
    const toCopy = Math.min(block.length, length - offset);
    result.set(block.subarray(0, toCopy), offset);
    offset += toCopy;
    counter += 1;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/** Generate cryptographically random bytes. */
function getRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    // Fallback for environments without Web Crypto.
    for (let i = 0; i < length; i++) {
      bytes[i] = (Math.random() * 256) >>> 0;
    }
  }
  return bytes;
}

/** Generate a random 32-byte private key. */
function generateRandomPrivkey(): Uint8Array {
  return getRandomBytes(32);
}

/** Return a fuzzed timestamp for the gift wrap layer. */
function fuzzTimestamp(baseTimestamp: number): number {
  const offset = Math.floor(
    Math.random() * TIMESTAMP_FUZZ_RANGE_SECONDS * 2 -
      TIMESTAMP_FUZZ_RANGE_SECONDS,
  );
  return baseTimestamp + offset;
}

/** Compute the event ID as SHA-256 of the serialised event. */
function computeEventId(event: UnsignedEvent & { pubkey: string }): string {
  const serialised = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
  const hash = sha256(new TextEncoder().encode(serialised));
  return bytesToHex(hash);
}

/** Encode Uint8Array to base-64 string. */
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return globalThis.btoa(binary);
}

/** Decode base-64 string to Uint8Array. */
function base64ToUint8(b64: string): Uint8Array {
  const binary = globalThis.atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// EventBuilder
// ---------------------------------------------------------------------------

/**
 * Builds NIP-17 gift-wrapped direct messages and unwraps received ones.
 */
const EventBuilder = {
  /**
   * Build a NIP-17 gift-wrapped direct message.
   *
   * Produces a kind 1059 event that can be published to relays. The message
   * is triple-encrypted: first as a kind 14 DM, sealed in a kind 13
   * envelope, and gift-wrapped in a kind 1059 outer event signed by a
   * random keypair.
   *
   * @param content          The plaintext message content.
   * @param recipientPubkey  Hex-encoded public key of the recipient.
   * @param senderPrivkey    32-byte private key of the sender.
   * @returns A fully signed kind 1059 NostrEvent ready for publishing.
   */
  async buildDirectMessage(
    content: string,
    recipientPubkey: string,
    senderPrivkey: Uint8Array,
  ): Promise<NostrEvent> {
    const senderPubkey = bytesToHex(getPublicKey(senderPrivkey));
    const now = Math.floor(Date.now() / 1000);

    // -----------------------------------------------------------------------
    // Layer 1: Kind 14 - DM content (inner event)
    // -----------------------------------------------------------------------

    const innerEvent: UnsignedEvent & { pubkey: string } = {
      kind: KIND_DM,
      created_at: now,
      tags: [['p', recipientPubkey]],
      content,
      pubkey: senderPubkey,
    };

    const innerId = computeEventId(innerEvent);
    const innerSerialized = JSON.stringify({
      id: innerId,
      ...innerEvent,
    });

    // -----------------------------------------------------------------------
    // Layer 2: Kind 13 - Seal (encrypt inner to recipient)
    // -----------------------------------------------------------------------

    const sealContent = nip44Encrypt(
      innerSerialized,
      senderPrivkey,
      recipientPubkey,
    );

    const sealUnsigned = {
      kind: KIND_SEAL,
      created_at: now,
      tags: [] as string[][],
      content: sealContent,
    };

    // finalizeEvent computes the ID and signs the event.
    const sealEvent = finalizeEvent(sealUnsigned, senderPrivkey);

    // -----------------------------------------------------------------------
    // Layer 3: Kind 1059 - Gift wrap (encrypt seal to recipient, sign with
    //          random key for metadata privacy)
    // -----------------------------------------------------------------------

    const wrapperPrivkey = generateRandomPrivkey();
    const wrapperPubkey = bytesToHex(getPublicKey(wrapperPrivkey));

    const giftWrapContent = nip44Encrypt(
      JSON.stringify(sealEvent),
      wrapperPrivkey,
      recipientPubkey,
    );

    const giftWrapUnsigned = {
      kind: KIND_GIFT_WRAP,
      created_at: fuzzTimestamp(now),
      tags: [['p', recipientPubkey]],
      content: giftWrapContent,
    };

    const giftWrapEvent = finalizeEvent(giftWrapUnsigned, wrapperPrivkey);

    return giftWrapEvent as unknown as NostrEvent;
  },

  /**
   * Unwrap a received NIP-17 gift-wrapped direct message.
   *
   * Decrypts the gift wrap (kind 1059), then the seal (kind 13), and
   * extracts the inner DM (kind 14) content.
   *
   * @param event          The received kind 1059 event.
   * @param recipientPrivkey 32-byte private key of the recipient.
   * @returns The decrypted message, sender pubkey, and timestamp, or null
   *          if unwrapping fails.
   */
  unwrapGiftWrap(
    event: NostrEvent,
    recipientPrivkey: Uint8Array,
  ): UnwrappedMessage | null {
    try {
      if (event.kind !== KIND_GIFT_WRAP) {
        return null;
      }

      // -------------------------------------------------------------------
      // Unwrap Layer 3: Decrypt the gift wrap to get the seal.
      // -------------------------------------------------------------------

      const sealJson = nip44Decrypt(
        event.content,
        recipientPrivkey,
        event.pubkey,
      );

      let sealEvent: NostrEvent;
      try {
        sealEvent = JSON.parse(sealJson);
      } catch {
        return null;
      }

      if (sealEvent.kind !== KIND_SEAL) {
        return null;
      }

      // -------------------------------------------------------------------
      // Unwrap Layer 2: Decrypt the seal to get the inner DM.
      // -------------------------------------------------------------------

      const innerJson = nip44Decrypt(
        sealEvent.content,
        recipientPrivkey,
        sealEvent.pubkey,
      );

      let innerEvent: { kind: number; content: string; pubkey: string; created_at: number; tags: string[][] };
      try {
        innerEvent = JSON.parse(innerJson);
      } catch {
        return null;
      }

      if (innerEvent.kind !== KIND_DM) {
        return null;
      }

      // -------------------------------------------------------------------
      // Extract the DM content.
      // -------------------------------------------------------------------

      return {
        content: innerEvent.content,
        senderPubkey: sealEvent.pubkey,
        timestamp: innerEvent.created_at,
      };
    } catch {
      // Any decryption or parsing failure means the event is not for us
      // or is malformed.
      return null;
    }
  },
};

export default EventBuilder;
