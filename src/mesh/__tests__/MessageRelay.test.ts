/**
 * MessageRelay.test.ts - Unit tests for the Jisr store-and-forward relay queue.
 */

import { MessageRelay, SendToPeerFn } from '../MessageRelay';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a 4-byte destination prefix from an integer. */
function makeDstId(n: number): Uint8Array {
  const buf = new Uint8Array(4);
  const view = new DataView(buf.buffer);
  view.setUint32(0, n, false);
  return buf;
}

/** Create a fake packet payload of the given size. */
function makePacket(size: number, fill = 0xAA): Uint8Array {
  return new Uint8Array(size).fill(fill);
}

/** No-op send function for tests that don't need to inspect sends. */
const noopSend: SendToPeerFn = () => {};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MessageRelay', () => {
  let relay: MessageRelay;
  let sentMessages: Array<{ peerId: string; data: Uint8Array }>;
  let mockSend: SendToPeerFn;

  beforeEach(() => {
    sentMessages = [];
    mockSend = (peerId: string, data: Uint8Array) => {
      sentMessages.push({ peerId, data });
    };
    relay = new MessageRelay(mockSend);
  });

  afterEach(() => {
    relay.destroy();
  });

  // -----------------------------------------------------------------------
  // queueForPeer
  // -----------------------------------------------------------------------

  describe('queueForPeer()', () => {
    it('stores a message and increases queue size', () => {
      expect(relay.getQueueSize()).toBe(0);
      relay.queueForPeer(makeDstId(1), makePacket(10));
      expect(relay.getQueueSize()).toBe(1);
    });

    it('stores multiple messages', () => {
      relay.queueForPeer(makeDstId(1), makePacket(10));
      relay.queueForPeer(makeDstId(2), makePacket(20));
      relay.queueForPeer(makeDstId(3), makePacket(30));
      expect(relay.getQueueSize()).toBe(3);
    });

    it('makes a defensive copy of the packet', () => {
      const pkt = makePacket(4, 0x11);
      relay.queueForPeer(makeDstId(1), pkt);

      // Mutate the original
      pkt[0] = 0xFF;

      // The queued message should retain the original value.
      // Verify indirectly by flushing to a mock.
      relay.onPeerConnected('peer1', makeDstId(1));
      expect(sentMessages.length).toBe(1);
      expect(sentMessages[0].data[0]).toBe(0x11);
    });

    it('rejects dstId that is not 4 bytes', () => {
      expect(() => relay.queueForPeer(new Uint8Array(3), makePacket(10))).toThrow(RangeError);
      expect(() => relay.queueForPeer(new Uint8Array(5), makePacket(10))).toThrow(RangeError);
    });
  });

  // -----------------------------------------------------------------------
  // getQueueSize
  // -----------------------------------------------------------------------

  describe('getQueueSize()', () => {
    it('returns 0 for empty queue', () => {
      expect(relay.getQueueSize()).toBe(0);
    });

    it('returns correct count after insertions', () => {
      for (let i = 0; i < 5; i++) {
        relay.queueForPeer(makeDstId(i), makePacket(10));
      }
      expect(relay.getQueueSize()).toBe(5);
    });
  });

  // -----------------------------------------------------------------------
  // pruneExpired
  // -----------------------------------------------------------------------

  describe('pruneExpired()', () => {
    it('removes expired messages', () => {
      relay.queueForPeer(makeDstId(1), makePacket(10));
      expect(relay.getQueueSize()).toBe(1);

      // Fast-forward time by more than 1 hour (MESSAGE_TTL_MS = 3600000)
      const originalNow = Date.now;
      Date.now = () => originalNow() + 3600001;

      try {
        const pruned = relay.pruneExpired();
        expect(pruned).toBe(1);
        expect(relay.getQueueSize()).toBe(0);
      } finally {
        Date.now = originalNow;
      }
    });

    it('keeps non-expired messages', () => {
      relay.queueForPeer(makeDstId(1), makePacket(10));
      const pruned = relay.pruneExpired();
      expect(pruned).toBe(0);
      expect(relay.getQueueSize()).toBe(1);
    });

    it('returns the number of pruned messages', () => {
      // Queue 3 messages
      relay.queueForPeer(makeDstId(1), makePacket(10));
      relay.queueForPeer(makeDstId(2), makePacket(10));
      relay.queueForPeer(makeDstId(3), makePacket(10));

      const originalNow = Date.now;
      Date.now = () => originalNow() + 3600001;

      try {
        const pruned = relay.pruneExpired();
        expect(pruned).toBe(3);
      } finally {
        Date.now = originalNow;
      }
    });

    it('selectively prunes only expired messages', () => {
      // Queue a message "now"
      relay.queueForPeer(makeDstId(1), makePacket(10));

      const originalNow = Date.now;
      const baseTime = originalNow();

      // Fast-forward 30 minutes and queue another message
      Date.now = () => baseTime + 30 * 60 * 1000;
      relay.queueForPeer(makeDstId(2), makePacket(20));

      // Fast-forward to 61 minutes (first message expired, second not)
      Date.now = () => baseTime + 61 * 60 * 1000;

      try {
        const pruned = relay.pruneExpired();
        expect(pruned).toBe(1);
        expect(relay.getQueueSize()).toBe(1);
      } finally {
        Date.now = originalNow;
      }
    });
  });

  // -----------------------------------------------------------------------
  // Queue capacity (MAX_QUEUE_SIZE = 500)
  // -----------------------------------------------------------------------

  describe('queue capacity (500)', () => {
    it('respects the 500-message limit', () => {
      for (let i = 0; i < 600; i++) {
        relay.queueForPeer(makeDstId(i % 256), makePacket(4, i & 0xFF));
      }
      expect(relay.getQueueSize()).toBe(500);
    });

    it('evicts oldest messages when full (FIFO)', () => {
      const dstId = makeDstId(0x01020304);

      // Fill with 500 messages, payload = index
      for (let i = 0; i < 500; i++) {
        relay.queueForPeer(dstId, new Uint8Array([i & 0xFF]));
      }
      expect(relay.getQueueSize()).toBe(500);

      // Add one more -- should evict the oldest (index 0)
      relay.queueForPeer(dstId, new Uint8Array([0xFE]));
      expect(relay.getQueueSize()).toBe(500);

      // Flush all messages to inspect them
      relay.onPeerConnected('peer1', dstId);

      // The first sent message should be index 1 (index 0 was evicted)
      expect(sentMessages.length).toBe(500);
      expect(sentMessages[0].data[0]).toBe(1); // oldest surviving = index 1
      expect(sentMessages[499].data[0]).toBe(0xFE); // newest = the one we just added
    });

    it('can fill to exactly 500 without eviction', () => {
      for (let i = 0; i < 500; i++) {
        relay.queueForPeer(makeDstId(1), makePacket(4));
      }
      expect(relay.getQueueSize()).toBe(500);
    });
  });

  // -----------------------------------------------------------------------
  // onPeerConnected (flush)
  // -----------------------------------------------------------------------

  describe('onPeerConnected()', () => {
    it('flushes messages matching the connected peer prefix', () => {
      const peerPrefix = makeDstId(0xAAAAAAAA);
      const otherPrefix = makeDstId(0xBBBBBBBB);

      relay.queueForPeer(peerPrefix, makePacket(10, 0x11));
      relay.queueForPeer(otherPrefix, makePacket(10, 0x22));
      relay.queueForPeer(peerPrefix, makePacket(10, 0x33));

      relay.onPeerConnected('ble-peer-1', peerPrefix);

      // Two messages should have been sent
      expect(sentMessages.length).toBe(2);
      expect(sentMessages[0].peerId).toBe('ble-peer-1');
      expect(sentMessages[0].data[0]).toBe(0x11);
      expect(sentMessages[1].data[0]).toBe(0x33);

      // Only the unmatched message remains
      expect(relay.getQueueSize()).toBe(1);
    });

    it('does not flush expired messages', () => {
      const prefix = makeDstId(1);
      relay.queueForPeer(prefix, makePacket(10));

      const originalNow = Date.now;
      Date.now = () => originalNow() + 3600001;

      try {
        relay.onPeerConnected('peer1', prefix);
        // Expired message should be silently dropped, not sent
        expect(sentMessages.length).toBe(0);
        expect(relay.getQueueSize()).toBe(0);
      } finally {
        Date.now = originalNow;
      }
    });

    it('rejects peerIdPrefix not 4 bytes', () => {
      expect(() => relay.onPeerConnected('peer1', new Uint8Array(3))).toThrow(RangeError);
    });

    it('keeps message in queue if send fails', () => {
      const failRelay = new MessageRelay(() => {
        throw new Error('BLE send failed');
      });

      const prefix = makeDstId(1);
      failRelay.queueForPeer(prefix, makePacket(10));

      // Suppress console.error output from the relay
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      failRelay.onPeerConnected('peer1', prefix);

      // Message should still be in the queue for retry
      expect(failRelay.getQueueSize()).toBe(1);

      consoleSpy.mockRestore();
      failRelay.destroy();
    });
  });

  // -----------------------------------------------------------------------
  // getQueueSizeForPeer
  // -----------------------------------------------------------------------

  describe('getQueueSizeForPeer()', () => {
    it('returns count of messages for a specific destination', () => {
      const dst1 = makeDstId(1);
      const dst2 = makeDstId(2);

      relay.queueForPeer(dst1, makePacket(10));
      relay.queueForPeer(dst1, makePacket(10));
      relay.queueForPeer(dst2, makePacket(10));

      expect(relay.getQueueSizeForPeer(dst1)).toBe(2);
      expect(relay.getQueueSizeForPeer(dst2)).toBe(1);
      expect(relay.getQueueSizeForPeer(makeDstId(99))).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // destroy
  // -----------------------------------------------------------------------

  describe('destroy()', () => {
    it('clears the queue', () => {
      relay.queueForPeer(makeDstId(1), makePacket(10));
      relay.queueForPeer(makeDstId(2), makePacket(10));
      expect(relay.getQueueSize()).toBe(2);

      relay.destroy();
      expect(relay.getQueueSize()).toBe(0);
    });
  });
});
