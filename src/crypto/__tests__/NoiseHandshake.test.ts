/**
 * NoiseHandshake.test.ts - Unit tests for the Noise XX handshake state machine.
 *
 * Tests the full XX pattern handshake between two NoiseHandshake instances,
 * verifying key agreement, state transitions, and error handling.
 *
 * Runs on Node.js -- no device or emulator needed.
 */

import { x25519 } from '@noble/curves/ed25519';
import * as crypto from 'crypto';
import { NoiseHandshake } from '../NoiseHandshake';
import type { HandshakeState } from '../NoiseHandshake';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate an X25519 keypair using @noble/curves. */
function generateX25519Keypair(): {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
} {
  const secretKey = crypto.randomBytes(32);
  const publicKey = x25519.getPublicKey(secretKey);
  return { publicKey, secretKey };
}

/** Byte-level equality check for Uint8Arrays. */
function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NoiseHandshake', () => {
  // -------------------------------------------------------------------------
  // Full XX handshake (happy path)
  // -------------------------------------------------------------------------

  describe('full XX handshake between initiator and responder', () => {
    let initiator: NoiseHandshake;
    let responder: NoiseHandshake;
    let initiatorKey: { publicKey: Uint8Array; secretKey: Uint8Array };
    let responderKey: { publicKey: Uint8Array; secretKey: Uint8Array };

    beforeEach(() => {
      initiator = new NoiseHandshake();
      responder = new NoiseHandshake();
      initiatorKey = generateX25519Keypair();
      responderKey = generateX25519Keypair();
    });

    it('should complete a 3-message handshake and produce matching session keys', () => {
      // Step 1: Initiator sends msg1 (-> e)
      const msg1 = initiator.initiateHandshake(initiatorKey);
      expect(msg1).toBeInstanceOf(Uint8Array);
      expect(msg1.length).toBeGreaterThan(0);

      // Step 2: Responder handles msg1, produces msg2 (<- e, ee, s, es)
      const result2 = responder.handleMessage(msg1, responderKey);
      expect(result2.complete).toBe(false);
      expect(result2.response).toBeDefined();
      expect(result2.session).toBeUndefined();
      const msg2 = result2.response!;

      // Step 3: Initiator handles msg2, produces msg3 (-> s, se), completes
      const result3 = initiator.handleMessage(msg2);
      expect(result3.complete).toBe(true);
      expect(result3.response).toBeDefined();
      expect(result3.session).toBeDefined();
      const msg3 = result3.response!;
      const initiatorSession = result3.session!;

      // Step 4: Responder handles msg3, completes
      const result4 = responder.handleMessage(msg3);
      expect(result4.complete).toBe(true);
      expect(result4.response).toBeUndefined();
      expect(result4.session).toBeDefined();
      const responderSession = result4.session!;

      // Verify key agreement: initiator's sendKey === responder's receiveKey
      expect(arraysEqual(initiatorSession.sendKey, responderSession.receiveKey)).toBe(true);

      // Verify key agreement: initiator's receiveKey === responder's sendKey
      expect(arraysEqual(initiatorSession.receiveKey, responderSession.sendKey)).toBe(true);

      // Keys should be 32 bytes
      expect(initiatorSession.sendKey.length).toBe(32);
      expect(initiatorSession.receiveKey.length).toBe(32);
      expect(responderSession.sendKey.length).toBe(32);
      expect(responderSession.receiveKey.length).toBe(32);

      // Send and receive keys should be different from each other
      expect(arraysEqual(initiatorSession.sendKey, initiatorSession.receiveKey)).toBe(false);

      // Nonces should start at 0
      expect(initiatorSession.sendNonce).toBe(0);
      expect(initiatorSession.receiveNonce).toBe(0);
      expect(responderSession.sendNonce).toBe(0);
      expect(responderSession.receiveNonce).toBe(0);
    });

    it('should report the correct remote public key for both sides', () => {
      const msg1 = initiator.initiateHandshake(initiatorKey);
      const { response: msg2 } = responder.handleMessage(msg1, responderKey);
      const { response: msg3, session: iSession } = initiator.handleMessage(msg2!);
      const { session: rSession } = responder.handleMessage(msg3!);

      // Initiator should see responder's static public key
      expect(arraysEqual(iSession!.remotePublicKey, responderKey.publicKey)).toBe(true);

      // Responder should see initiator's static public key
      expect(arraysEqual(rSession!.remotePublicKey, initiatorKey.publicKey)).toBe(true);

      // getRemotePublicKey() should also return the correct values
      expect(arraysEqual(initiator.getRemotePublicKey()!, responderKey.publicKey)).toBe(true);
      expect(arraysEqual(responder.getRemotePublicKey()!, initiatorKey.publicKey)).toBe(true);
    });

    it('should mark both sides as complete after the handshake', () => {
      const msg1 = initiator.initiateHandshake(initiatorKey);
      const { response: msg2 } = responder.handleMessage(msg1, responderKey);
      const { response: msg3 } = initiator.handleMessage(msg2!);
      responder.handleMessage(msg3!);

      expect(initiator.isComplete()).toBe(true);
      expect(responder.isComplete()).toBe(true);
    });

    it('should produce different session keys for different keypairs', () => {
      // First handshake
      const msg1a = initiator.initiateHandshake(initiatorKey);
      const { response: msg2a } = responder.handleMessage(msg1a, responderKey);
      const { response: msg3a, session: sessionA } = initiator.handleMessage(msg2a!);
      responder.handleMessage(msg3a!);

      // Second handshake with different keys
      const initiator2 = new NoiseHandshake();
      const responder2 = new NoiseHandshake();
      const key2 = generateX25519Keypair();
      const key3 = generateX25519Keypair();

      const msg1b = initiator2.initiateHandshake(key2);
      const { response: msg2b } = responder2.handleMessage(msg1b, key3);
      const { session: sessionB } = initiator2.handleMessage(msg2b!);

      // The session keys should differ (overwhelmingly likely for random keys)
      expect(arraysEqual(sessionA!.sendKey, sessionB!.sendKey)).toBe(false);
    });

    it('should produce different session keys on repeated handshakes with the same static keys', () => {
      // First handshake
      const msg1a = initiator.initiateHandshake(initiatorKey);
      const { response: msg2a } = responder.handleMessage(msg1a, responderKey);
      const { response: msg3a, session: sessionA } = initiator.handleMessage(msg2a!);
      responder.handleMessage(msg3a!);

      // Second handshake with the same static keys but fresh ephemeral keys
      const initiator2 = new NoiseHandshake();
      const responder2 = new NoiseHandshake();

      const msg1b = initiator2.initiateHandshake(initiatorKey);
      const { response: msg2b } = responder2.handleMessage(msg1b, responderKey);
      const { session: sessionB } = initiator2.handleMessage(msg2b!);

      // Session keys should differ due to ephemeral randomness (forward secrecy)
      expect(arraysEqual(sessionA!.sendKey, sessionB!.sendKey)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // State transitions
  // -------------------------------------------------------------------------

  describe('state transitions', () => {
    let hs: NoiseHandshake;
    let key: { publicKey: Uint8Array; secretKey: Uint8Array };

    beforeEach(() => {
      hs = new NoiseHandshake();
      key = generateX25519Keypair();
    });

    it('should start in IDLE state', () => {
      expect(hs.getState()).toBe('IDLE');
    });

    it('initiator: IDLE -> MSG1_SENT after initiateHandshake', () => {
      hs.initiateHandshake(key);
      expect(hs.getState()).toBe('MSG1_SENT');
    });

    it('initiator: MSG1_SENT -> COMPLETE after handling msg2', () => {
      const initiator = new NoiseHandshake();
      const responder = new NoiseHandshake();
      const iKey = generateX25519Keypair();
      const rKey = generateX25519Keypair();

      const msg1 = initiator.initiateHandshake(iKey);
      expect(initiator.getState()).toBe('MSG1_SENT');

      const { response: msg2 } = responder.handleMessage(msg1, rKey);
      initiator.handleMessage(msg2!);
      expect(initiator.getState()).toBe('COMPLETE');
    });

    it('responder: IDLE -> MSG2_SENT after handling msg1', () => {
      const initiator = new NoiseHandshake();
      const responder = new NoiseHandshake();
      const iKey = generateX25519Keypair();
      const rKey = generateX25519Keypair();

      expect(responder.getState()).toBe('IDLE');

      const msg1 = initiator.initiateHandshake(iKey);
      responder.handleMessage(msg1, rKey);
      expect(responder.getState()).toBe('MSG2_SENT');
    });

    it('responder: MSG2_SENT -> COMPLETE after handling msg3', () => {
      const initiator = new NoiseHandshake();
      const responder = new NoiseHandshake();
      const iKey = generateX25519Keypair();
      const rKey = generateX25519Keypair();

      const msg1 = initiator.initiateHandshake(iKey);
      const { response: msg2 } = responder.handleMessage(msg1, rKey);
      const { response: msg3 } = initiator.handleMessage(msg2!);
      responder.handleMessage(msg3!);
      expect(responder.getState()).toBe('COMPLETE');
    });

    it('should not report complete before handshake finishes', () => {
      expect(hs.isComplete()).toBe(false);
      hs.initiateHandshake(key);
      expect(hs.isComplete()).toBe(false);
    });

    it('getRemotePublicKey() returns null before handshake completes', () => {
      expect(hs.getRemotePublicKey()).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Error: initiate from non-IDLE state
  // -------------------------------------------------------------------------

  describe('initiating from non-IDLE state', () => {
    it('should throw if initiateHandshake is called after already initiated', () => {
      const hs = new NoiseHandshake();
      const key = generateX25519Keypair();

      hs.initiateHandshake(key);
      expect(hs.getState()).toBe('MSG1_SENT');

      expect(() => hs.initiateHandshake(key)).toThrow(
        /Cannot initiate handshake from state MSG1_SENT/,
      );
    });

    it('should throw if initiateHandshake is called after COMPLETE', () => {
      const initiator = new NoiseHandshake();
      const responder = new NoiseHandshake();
      const iKey = generateX25519Keypair();
      const rKey = generateX25519Keypair();

      const msg1 = initiator.initiateHandshake(iKey);
      const { response: msg2 } = responder.handleMessage(msg1, rKey);
      const { response: msg3 } = initiator.handleMessage(msg2!);
      responder.handleMessage(msg3!);

      expect(() => initiator.initiateHandshake(iKey)).toThrow(
        /Cannot initiate handshake from state COMPLETE/,
      );
    });

    it('should throw if initiateHandshake is called after ABORTED', () => {
      const hs = new NoiseHandshake();
      const key = generateX25519Keypair();

      hs.abort();
      expect(() => hs.initiateHandshake(key)).toThrow(
        /Cannot initiate handshake from state ABORTED/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Error: handleMessage in unexpected state
  // -------------------------------------------------------------------------

  describe('handleMessage in unexpected state', () => {
    it('should throw if handleMessage is called on a COMPLETE handshake', () => {
      const initiator = new NoiseHandshake();
      const responder = new NoiseHandshake();
      const iKey = generateX25519Keypair();
      const rKey = generateX25519Keypair();

      const msg1 = initiator.initiateHandshake(iKey);
      const { response: msg2 } = responder.handleMessage(msg1, rKey);
      const { response: msg3 } = initiator.handleMessage(msg2!);
      responder.handleMessage(msg3!);

      // Trying to feed another message after completion should throw
      expect(() => initiator.handleMessage(new Uint8Array(64))).toThrow(
        /Unexpected message in state COMPLETE/,
      );
    });

    it('should throw if responder receives msg1 without providing localStaticKey', () => {
      const initiator = new NoiseHandshake();
      const responder = new NoiseHandshake();
      const iKey = generateX25519Keypair();

      const msg1 = initiator.initiateHandshake(iKey);

      // Responder is in IDLE and must provide a key
      expect(() => responder.handleMessage(msg1)).toThrow(
        /localStaticKey must be provided/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Abort
  // -------------------------------------------------------------------------

  describe('abort', () => {
    it('should transition to ABORTED state', () => {
      const hs = new NoiseHandshake();
      const key = generateX25519Keypair();

      hs.initiateHandshake(key);
      expect(hs.getState()).toBe('MSG1_SENT');

      hs.abort();
      expect(hs.getState()).toBe('ABORTED');
      expect(hs.isComplete()).toBe(false);
    });

    it('should be callable from IDLE state', () => {
      const hs = new NoiseHandshake();
      hs.abort();
      expect(hs.getState()).toBe('ABORTED');
    });

    it('should prevent further handshake progress after abort', () => {
      const hs = new NoiseHandshake();
      const key = generateX25519Keypair();

      hs.abort();

      // Cannot initiate after abort
      expect(() => hs.initiateHandshake(key)).toThrow(
        /Cannot initiate handshake from state ABORTED/,
      );

      // Cannot handle messages after abort
      expect(() => hs.handleMessage(new Uint8Array(64))).toThrow(
        /Unexpected message in state ABORTED/,
      );
    });

    it('abort during MSG2_SENT state works', () => {
      const initiator = new NoiseHandshake();
      const responder = new NoiseHandshake();
      const iKey = generateX25519Keypair();
      const rKey = generateX25519Keypair();

      const msg1 = initiator.initiateHandshake(iKey);
      responder.handleMessage(msg1, rKey);
      expect(responder.getState()).toBe('MSG2_SENT');

      responder.abort();
      expect(responder.getState()).toBe('ABORTED');
    });
  });

  // -------------------------------------------------------------------------
  // Message format sanity checks
  // -------------------------------------------------------------------------

  describe('message format', () => {
    it('msg1 should be at least 32 bytes (one ephemeral public key)', () => {
      const hs = new NoiseHandshake();
      const key = generateX25519Keypair();
      const msg1 = hs.initiateHandshake(key);

      // msg1 = ephemeral pub (32 bytes) + encrypted empty payload
      expect(msg1.length).toBeGreaterThanOrEqual(32);
    });

    it('msg2 should be larger than msg1 (contains encrypted static key)', () => {
      const initiator = new NoiseHandshake();
      const responder = new NoiseHandshake();
      const iKey = generateX25519Keypair();
      const rKey = generateX25519Keypair();

      const msg1 = initiator.initiateHandshake(iKey);
      const { response: msg2 } = responder.handleMessage(msg1, rKey);

      // msg2 = eph (32) + encrypted static (32+16) + encrypted payload (0+16) = 96
      expect(msg2!.length).toBeGreaterThan(msg1.length);
    });
  });
});
