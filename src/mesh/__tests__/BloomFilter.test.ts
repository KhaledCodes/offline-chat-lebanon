/**
 * BloomFilter.test.ts - Unit tests for the Jisr probabilistic message dedup filter.
 */

import { BloomFilter } from '../BloomFilter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a deterministic 8-byte message ID from an integer index. */
function makeMessageId(index: number): Uint8Array {
  const id = new Uint8Array(8);
  const view = new DataView(id.buffer);
  view.setUint32(0, 0, false);
  view.setUint32(4, index, false);
  return id;
}

/** Create a random 8-byte message ID. */
function randomMessageId(): Uint8Array {
  const id = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    id[i] = (Math.random() * 256) >>> 0;
  }
  return id;
}

// ---------------------------------------------------------------------------
// Basic add / has
// ---------------------------------------------------------------------------

describe('BloomFilter', () => {
  let bf: BloomFilter;

  beforeEach(() => {
    bf = new BloomFilter();
  });

  describe('add() and has()', () => {
    it('returns true for an item that was added', () => {
      const id = makeMessageId(1);
      bf.add(id);
      expect(bf.has(id)).toBe(true);
    });

    it('returns true for multiple added items', () => {
      const ids = [makeMessageId(10), makeMessageId(20), makeMessageId(30)];
      for (const id of ids) {
        bf.add(id);
      }
      for (const id of ids) {
        expect(bf.has(id)).toBe(true);
      }
    });

    it('returns false for an item that was never added (high probability)', () => {
      bf.add(makeMessageId(1));
      // Check several items that were not added
      for (let i = 100; i < 200; i++) {
        // At least 99% of these should be false for an empty-ish filter
      }
      // A single fresh filter with one insertion should not match an unrelated ID
      expect(bf.has(makeMessageId(999999))).toBe(false);
    });

    it('returns false for a completely empty filter', () => {
      expect(bf.has(makeMessageId(42))).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Large-scale insertion
  // -----------------------------------------------------------------------

  describe('large-scale insertion (1000 items)', () => {
    it('all 1000 added items are found', () => {
      const count = 1000;
      const ids: Uint8Array[] = [];

      for (let i = 0; i < count; i++) {
        const id = makeMessageId(i);
        ids.push(id);
        bf.add(id);
      }

      for (const id of ids) {
        expect(bf.has(id)).toBe(true);
      }
    });

    it('false positive rate is below 1% at 1000 inserted items', () => {
      // Insert 1000 items
      for (let i = 0; i < 1000; i++) {
        bf.add(makeMessageId(i));
      }

      // Test 10000 items that were NOT inserted (starting from offset 100000)
      const testCount = 10000;
      let falsePositives = 0;
      for (let i = 100000; i < 100000 + testCount; i++) {
        if (bf.has(makeMessageId(i))) {
          falsePositives++;
        }
      }

      const fpRate = falsePositives / testCount;
      // The filter is designed for ~0.01% FP at 10k items.
      // At 1000 items it should be well below 1%.
      expect(fpRate).toBeLessThan(0.01);
    });
  });

  // -----------------------------------------------------------------------
  // clear()
  // -----------------------------------------------------------------------

  describe('clear()', () => {
    it('makes all previously added items return false', () => {
      const ids = [makeMessageId(1), makeMessageId(2), makeMessageId(3)];
      for (const id of ids) {
        bf.add(id);
      }

      // Verify they are present
      for (const id of ids) {
        expect(bf.has(id)).toBe(true);
      }

      bf.clear();

      // After clear, all should be absent
      for (const id of ids) {
        expect(bf.has(id)).toBe(false);
      }
    });

    it('resets rawInsertions to 0', () => {
      bf.add(makeMessageId(1));
      bf.add(makeMessageId(2));
      expect(bf.rawInsertions).toBe(2);

      bf.clear();
      expect(bf.rawInsertions).toBe(0);
    });

    it('resets estimatedCount to 0', () => {
      bf.add(makeMessageId(1));
      bf.add(makeMessageId(2));
      expect(bf.estimatedCount()).toBeGreaterThan(0);

      bf.clear();
      expect(bf.estimatedCount()).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // estimatedCount()
  // -----------------------------------------------------------------------

  describe('estimatedCount()', () => {
    it('returns 0 for an empty filter', () => {
      expect(bf.estimatedCount()).toBe(0);
    });

    it('is approximately correct after 100 insertions', () => {
      const n = 100;
      for (let i = 0; i < n; i++) {
        bf.add(makeMessageId(i));
      }

      const estimate = bf.estimatedCount();
      // Allow +/- 20% tolerance
      expect(estimate).toBeGreaterThanOrEqual(n * 0.8);
      expect(estimate).toBeLessThanOrEqual(n * 1.2);
    });

    it('is approximately correct after 1000 insertions', () => {
      const n = 1000;
      for (let i = 0; i < n; i++) {
        bf.add(makeMessageId(i));
      }

      const estimate = bf.estimatedCount();
      // Allow +/- 15% tolerance
      expect(estimate).toBeGreaterThanOrEqual(n * 0.85);
      expect(estimate).toBeLessThanOrEqual(n * 1.15);
    });

    it('duplicate insertions do not inflate the estimate significantly', () => {
      const n = 50;
      // Add 50 unique items
      for (let i = 0; i < n; i++) {
        bf.add(makeMessageId(i));
      }
      // Add them all again (duplicates)
      for (let i = 0; i < n; i++) {
        bf.add(makeMessageId(i));
      }

      const estimate = bf.estimatedCount();
      // estimatedCount is based on set bits, so duplicates should not inflate it
      expect(estimate).toBeGreaterThanOrEqual(n * 0.8);
      expect(estimate).toBeLessThanOrEqual(n * 1.3);
    });
  });

  // -----------------------------------------------------------------------
  // Auto-reset at threshold
  // -----------------------------------------------------------------------

  describe('auto-reset', () => {
    it('triggers when estimated insertion count exceeds 50000', () => {
      // Insert exactly 50000 items so rawInsertions reaches the threshold
      for (let i = 0; i < 50000; i++) {
        bf.add(makeMessageId(i));
      }

      expect(bf.rawInsertions).toBe(50000);

      // The next add() should trigger a clear (insertions >= 50000)
      // and then insert the new item, so rawInsertions becomes 1
      const newId = makeMessageId(99999);
      bf.add(newId);

      expect(bf.rawInsertions).toBe(1);
      // The new item should be present
      expect(bf.has(newId)).toBe(true);
      // An old item should be absent (filter was cleared)
      expect(bf.has(makeMessageId(0))).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Various message ID formats
  // -----------------------------------------------------------------------

  describe('various message ID formats', () => {
    it('works with all-zero ID', () => {
      const id = new Uint8Array(8).fill(0x00);
      bf.add(id);
      expect(bf.has(id)).toBe(true);
    });

    it('works with all-ones ID (0xFF)', () => {
      const id = new Uint8Array(8).fill(0xff);
      bf.add(id);
      expect(bf.has(id)).toBe(true);
    });

    it('works with random IDs', () => {
      const ids: Uint8Array[] = [];
      for (let i = 0; i < 50; i++) {
        ids.push(randomMessageId());
      }

      for (const id of ids) {
        bf.add(id);
      }

      for (const id of ids) {
        expect(bf.has(id)).toBe(true);
      }
    });

    it('distinguishes between similar IDs (differ by one bit)', () => {
      const a = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
      const b = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01]);

      bf.add(a);
      expect(bf.has(a)).toBe(true);
      // b was not added -- with high probability it should be absent
      // (FP rate at 1 item in a 65536-bit filter with 7 hashes is negligible)
      expect(bf.has(b)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Accessors
  // -----------------------------------------------------------------------

  describe('accessors', () => {
    it('sizeBytes returns 8192', () => {
      expect(bf.sizeBytes).toBe(8192);
    });

    it('hashCount returns 7', () => {
      expect(bf.hashCount).toBe(7);
    });

    it('rawInsertions tracks total insertions including duplicates', () => {
      bf.add(makeMessageId(1));
      bf.add(makeMessageId(1)); // duplicate
      bf.add(makeMessageId(2));
      expect(bf.rawInsertions).toBe(3);
    });
  });
});
