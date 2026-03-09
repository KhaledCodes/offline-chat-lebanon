/**
 * BloomFilter.ts - Space-efficient probabilistic set for message dedup.
 *
 * Configuration:
 *   Size            8 192 bytes  (65 536 bits)
 *   Hash functions  7            (FNV-1a variants with distinct seeds)
 *   Expected items  ~10 000      at target false-positive rate
 *   False-positive  ~0.01 %      at 10 000 items
 *   Auto-reset      > 50 000 estimated insertions
 *
 * Each hash function is a 32-bit FNV-1a seeded with a unique offset so the
 * seven functions are independent.  The result is taken modulo the total
 * bit-count (65 536) to produce a bit index.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Filter storage size in bytes. */
const FILTER_BYTES = 8192;

/** Total bits in the filter. */
const FILTER_BITS = FILTER_BYTES * 8; // 65 536

/** Number of independent hash functions. */
const NUM_HASHES = 7;

/** Insertion count above which the filter is automatically cleared. */
const AUTO_RESET_THRESHOLD = 50_000;

// ---------------------------------------------------------------------------
// FNV-1a parameters
// ---------------------------------------------------------------------------

/**
 * FNV-1a 32-bit offset-basis.  Each of the 7 hash functions adds a
 * different seed to this value so the functions produce uncorrelated
 * outputs.
 */
const FNV1A_OFFSET_BASIS = 0x811c9dc5;

/** FNV-1a 32-bit prime. */
const FNV1A_PRIME = 0x01000193;

/**
 * Per-hash-function seeds.  These are simply small primes spread apart
 * so that the initial state differs meaningfully between functions.
 */
const HASH_SEEDS: ReadonlyArray<number> = [
  0x00000000,
  0x6b326ac4,
  0x3f2d1e4a,
  0x9c8b7a61,
  0x12f05e3d,
  0xe4d3c2b1,
  0x57a6f893,
];

// ---------------------------------------------------------------------------
// Hash helper
// ---------------------------------------------------------------------------

/**
 * Compute a single FNV-1a-32 hash of `data` using a given seed and return
 * a bit index in the range [0, FILTER_BITS).
 */
function fnv1aHash(data: Uint8Array, seed: number): number {
  let hash = (FNV1A_OFFSET_BASIS ^ seed) >>> 0;

  for (let i = 0; i < data.length; i++) {
    hash ^= data[i];
    // Multiply by FNV prime.  The `Math.imul` intrinsic gives us a proper
    // 32-bit multiply without BigInt overhead.
    hash = Math.imul(hash, FNV1A_PRIME) >>> 0;
  }

  // Map to a bit position.
  return hash % FILTER_BITS;
}

// ---------------------------------------------------------------------------
// BloomFilter class
// ---------------------------------------------------------------------------

export class BloomFilter {
  /** Underlying bit-storage. */
  private bits: Uint8Array;

  /** Running count of insertions (for estimated-count / auto-reset logic). */
  private insertions: number;

  constructor() {
    this.bits = new Uint8Array(FILTER_BYTES);
    this.insertions = 0;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Mark `messageId` as seen.
   *
   * If the estimated insertion count exceeds the auto-reset threshold the
   * filter is cleared first to keep the false-positive rate bounded.
   */
  add(messageId: Uint8Array): void {
    if (this.insertions >= AUTO_RESET_THRESHOLD) {
      this.clear();
    }

    for (let i = 0; i < NUM_HASHES; i++) {
      const bitIndex = fnv1aHash(messageId, HASH_SEEDS[i]);
      const byteIndex = bitIndex >>> 3;        // bitIndex / 8
      const bitOffset = bitIndex & 0x07;        // bitIndex % 8
      this.bits[byteIndex] |= (1 << bitOffset);
    }

    this.insertions++;
  }

  /**
   * Test whether `messageId` has (probably) been seen before.
   *
   * - `true`  => the ID *may* have been added (possible false positive).
   * - `false` => the ID has *definitely not* been added.
   */
  has(messageId: Uint8Array): boolean {
    for (let i = 0; i < NUM_HASHES; i++) {
      const bitIndex = fnv1aHash(messageId, HASH_SEEDS[i]);
      const byteIndex = bitIndex >>> 3;
      const bitOffset = bitIndex & 0x07;

      if ((this.bits[byteIndex] & (1 << bitOffset)) === 0) {
        return false;
      }
    }
    return true;
  }

  /**
   * Reset the filter to an empty state.
   */
  clear(): void {
    this.bits.fill(0);
    this.insertions = 0;
  }

  /**
   * Return an estimate of the number of distinct items inserted.
   *
   * Uses the classical formula:
   *
   *   n* = -(m / k) * ln(1 - X/m)
   *
   * where m = total bits, k = number of hash functions, and X = number of
   * set bits.  This is more accurate than the raw insertion counter when
   * duplicates have been added.
   */
  estimatedCount(): number {
    let setBits = 0;

    // Count set bits across the entire array.  Process 4 bytes at a time
    // with a parallel bit-count (Hamming weight) for speed.
    for (let i = 0; i < this.bits.length; i++) {
      let v = this.bits[i];
      // Brian Kernighan's algorithm for byte-width popcount.
      while (v) {
        v &= v - 1;
        setBits++;
      }
    }

    if (setBits === 0) {
      return 0;
    }

    // Avoid log(0) when the filter is completely saturated.
    if (setBits >= FILTER_BITS) {
      return AUTO_RESET_THRESHOLD;
    }

    const ratio = setBits / FILTER_BITS;
    return Math.round(-(FILTER_BITS / NUM_HASHES) * Math.log(1 - ratio));
  }

  // -----------------------------------------------------------------------
  // Accessors (useful for diagnostics / testing)
  // -----------------------------------------------------------------------

  /** Raw insertion counter (not de-duplicated). */
  get rawInsertions(): number {
    return this.insertions;
  }

  /** Filter size in bytes. */
  get sizeBytes(): number {
    return FILTER_BYTES;
  }

  /** Number of hash functions. */
  get hashCount(): number {
    return NUM_HASHES;
  }
}
