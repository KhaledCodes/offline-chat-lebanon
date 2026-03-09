/**
 * RelayManager.ts - Relay health tracking and intelligent selection for Jisr.
 *
 * Monitors the health of known Nostr relays by tracking latency, uptime,
 * error rates, and consecutive failures. Automatically connects to the
 * top-ranked relays based on a composite health score.
 *
 * Health score formula:
 *   score = uptime_ratio * (1 / latency_ms) * failure_penalty
 *
 * Where failure_penalty = max(0.1, 1 - consecutive_failures * 0.2)
 *
 * The manager re-evaluates relay health every 60 seconds and rotates
 * connections to maintain optimal connectivity.
 */

import nostrClient from './NostrClient';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Health metrics for a single relay. */
export interface RelayHealth {
  url: string;
  /** Average round-trip latency in milliseconds. */
  latencyMs: number;
  /** Ratio of successful connections to total attempts (0.0 - 1.0). */
  uptimeRatio: number;
  /** Timestamp (ms) of the last successful interaction. */
  lastSuccessAt: number;
  /** Timestamp (ms) of the last failure. */
  lastErrorAt: number;
  /** Description of the last error, if any. */
  lastErrorMessage: string;
  /** Number of consecutive failures without a success in between. */
  consecutiveFailures: number;
  /** Total successful interactions. */
  totalSuccesses: number;
  /** Total failed interactions. */
  totalFailures: number;
  /** Computed health score (higher is better). */
  score: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default set of well-known public relays. */
const DEFAULT_RELAYS: string[] = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.snort.social',
  'wss://nostr.mom',
  'wss://relay.nostr.band',
];

/** Number of top relays to keep connected simultaneously. */
const DEFAULT_ACTIVE_RELAY_COUNT = 3;

/** Re-evaluation interval in milliseconds. */
const REEVALUATION_INTERVAL_MS = 60_000;

/** Default latency assumption when no measurements exist yet (ms). */
const DEFAULT_LATENCY_MS = 500;

/** Minimum health score floor to prevent division-by-zero edge cases. */
const MIN_SCORE = 0.000001;

// ---------------------------------------------------------------------------
// Internal relay record
// ---------------------------------------------------------------------------

interface RelayRecord {
  url: string;
  latencyMs: number;
  totalSuccesses: number;
  totalFailures: number;
  consecutiveFailures: number;
  lastSuccessAt: number;
  lastErrorAt: number;
  lastErrorMessage: string;
  /** Latency samples for rolling average (last N measurements). */
  latencySamples: number[];
}

/** Maximum number of latency samples to retain for the rolling average. */
const MAX_LATENCY_SAMPLES = 20;

// ---------------------------------------------------------------------------
// RelayManager
// ---------------------------------------------------------------------------

/**
 * Manages a pool of Nostr relays, tracking their health and ensuring the
 * application stays connected to the best available set.
 */
class RelayManager {
  // -- state ----------------------------------------------------------------

  /** All known relay records keyed by URL. */
  private records: Map<string, RelayRecord> = new Map();

  /** Number of relays to keep active. */
  private activeCount: number = DEFAULT_ACTIVE_RELAY_COUNT;

  /** Periodic re-evaluation timer. */
  private reevalTimer: ReturnType<typeof setInterval> | null = null;

  /** Whether the manager has been started. */
  private running = false;

  // -- lifecycle ------------------------------------------------------------

  /**
   * Initialise the relay manager with default relays and begin periodic
   * health evaluation. Connects to the top relays immediately.
   *
   * @param relays  Optional list of relay URLs to use instead of defaults.
   * @param count   Number of simultaneous relay connections to maintain.
   */
  async start(
    relays: string[] = DEFAULT_RELAYS,
    count: number = DEFAULT_ACTIVE_RELAY_COUNT,
  ): Promise<void> {
    if (this.running) {
      return;
    }

    this.activeCount = count;

    // Seed relay records.
    for (const url of relays) {
      this.ensureRecord(url);
    }

    this.running = true;

    // Initial connection.
    await this.evaluateAndConnect();

    // Start periodic re-evaluation.
    this.reevalTimer = setInterval(() => {
      this.evaluateAndConnect().catch(() => {
        // Swallow errors in background re-evaluation.
      });
    }, REEVALUATION_INTERVAL_MS);
  }

  /**
   * Stop the relay manager, disconnecting from all relays and halting
   * periodic evaluation.
   */
  stop(): void {
    this.running = false;

    if (this.reevalTimer !== null) {
      clearInterval(this.reevalTimer);
      this.reevalTimer = null;
    }

    nostrClient.disconnectAll();
  }

  // -- public API -----------------------------------------------------------

  /**
   * Return the top N healthy relays sorted by health score (descending).
   *
   * @param count  Number of relays to return (default: activeCount).
   */
  getHealthyRelays(count?: number): string[] {
    const n = count ?? this.activeCount;
    return this.getSortedRecords()
      .slice(0, n)
      .map((r) => r.url);
  }

  /**
   * Report a successful interaction with a relay. Updates latency and
   * resets the consecutive failure counter.
   *
   * @param url       The relay URL.
   * @param latencyMs Optional measured round-trip latency in milliseconds.
   */
  reportSuccess(url: string, latencyMs?: number): void {
    const record = this.ensureRecord(url);
    record.totalSuccesses += 1;
    record.consecutiveFailures = 0;
    record.lastSuccessAt = Date.now();

    if (latencyMs !== undefined && latencyMs > 0) {
      record.latencySamples.push(latencyMs);
      if (record.latencySamples.length > MAX_LATENCY_SAMPLES) {
        record.latencySamples.shift();
      }
      record.latencyMs = this.computeAverageLatency(record.latencySamples);
    }
  }

  /**
   * Report a failed interaction with a relay.
   *
   * @param url     The relay URL.
   * @param error   Optional error description.
   */
  reportFailure(url: string, error?: string): void {
    const record = this.ensureRecord(url);
    record.totalFailures += 1;
    record.consecutiveFailures += 1;
    record.lastErrorAt = Date.now();
    record.lastErrorMessage = error ?? 'Unknown error';
  }

  /**
   * Add a new relay to the pool. If the manager is running, re-evaluation
   * will consider it on the next cycle.
   */
  addRelay(url: string): void {
    this.ensureRecord(url);
  }

  /**
   * Remove a relay from the pool and disconnect if currently connected.
   */
  removeRelay(url: string): void {
    const normalised = this.normaliseUrl(url);
    this.records.delete(normalised);
    nostrClient.disconnect(normalised);
  }

  /**
   * Get the health metrics for a specific relay.
   *
   * @returns The RelayHealth snapshot or null if the relay is unknown.
   */
  getRelayHealth(url: string): RelayHealth | null {
    const normalised = this.normaliseUrl(url);
    const record = this.records.get(normalised);
    if (!record) {
      return null;
    }
    return this.toRelayHealth(record);
  }

  /**
   * Return health metrics for all known relays, sorted by score descending.
   */
  getAllRelayHealth(): RelayHealth[] {
    return this.getSortedRecords().map((r) => this.toRelayHealth(r));
  }

  // -- health score ---------------------------------------------------------

  /**
   * Compute the health score for a relay record.
   *
   * score = uptimeRatio * (1 / latencyMs) * failurePenalty
   *
   * - uptimeRatio: successes / (successes + failures), or 0.5 if no data.
   * - latencyMs:   rolling average, or DEFAULT_LATENCY_MS if unknown.
   * - failurePenalty: max(0.1, 1 - consecutiveFailures * 0.2).
   */
  private computeScore(record: RelayRecord): number {
    const total = record.totalSuccesses + record.totalFailures;
    const uptimeRatio = total > 0 ? record.totalSuccesses / total : 0.5;

    const latency = record.latencyMs > 0 ? record.latencyMs : DEFAULT_LATENCY_MS;

    const failurePenalty = Math.max(
      0.1,
      1 - record.consecutiveFailures * 0.2,
    );

    const score = uptimeRatio * (1 / latency) * failurePenalty;
    return Math.max(score, MIN_SCORE);
  }

  // -- evaluation and connection --------------------------------------------

  /**
   * Evaluate all relay health scores, determine the top set, and adjust
   * connections accordingly (connect to new best relays, disconnect from
   * those that have fallen out of the top set).
   */
  private async evaluateAndConnect(): Promise<void> {
    const sorted = this.getSortedRecords();
    const topUrls = new Set(
      sorted.slice(0, this.activeCount).map((r) => r.url),
    );

    const currentlyConnected = new Set(nostrClient.getConnectedRelays());

    // Disconnect from relays no longer in the top set.
    for (const url of currentlyConnected) {
      if (!topUrls.has(url)) {
        nostrClient.disconnect(url);
      }
    }

    // Connect to relays in the top set that are not yet connected.
    const connectPromises: Promise<void>[] = [];
    for (const url of topUrls) {
      if (!currentlyConnected.has(url)) {
        const start = Date.now();
        const promise = nostrClient
          .connect(url)
          .then(() => {
            this.reportSuccess(url, Date.now() - start);
          })
          .catch((err: Error) => {
            this.reportFailure(url, err.message);
          });
        connectPromises.push(promise);
      }
    }

    // Wait for all connection attempts to settle.
    await Promise.allSettled(connectPromises);
  }

  // -- helpers --------------------------------------------------------------

  /**
   * Get or create a record for the given relay URL.
   */
  private ensureRecord(url: string): RelayRecord {
    const normalised = this.normaliseUrl(url);
    let record = this.records.get(normalised);
    if (!record) {
      record = {
        url: normalised,
        latencyMs: DEFAULT_LATENCY_MS,
        totalSuccesses: 0,
        totalFailures: 0,
        consecutiveFailures: 0,
        lastSuccessAt: 0,
        lastErrorAt: 0,
        lastErrorMessage: '',
        latencySamples: [],
      };
      this.records.set(normalised, record);
    }
    return record;
  }

  /**
   * Return all records sorted by health score descending.
   */
  private getSortedRecords(): RelayRecord[] {
    const records = Array.from(this.records.values());
    // Compute scores and sort.
    records.sort((a, b) => this.computeScore(b) - this.computeScore(a));
    return records;
  }

  /**
   * Compute the rolling average of latency samples.
   */
  private computeAverageLatency(samples: number[]): number {
    if (samples.length === 0) {
      return DEFAULT_LATENCY_MS;
    }
    const sum = samples.reduce((acc, val) => acc + val, 0);
    return Math.round(sum / samples.length);
  }

  /**
   * Convert an internal record to the public RelayHealth snapshot.
   */
  private toRelayHealth(record: RelayRecord): RelayHealth {
    const total = record.totalSuccesses + record.totalFailures;
    const uptimeRatio = total > 0 ? record.totalSuccesses / total : 0.5;

    return {
      url: record.url,
      latencyMs: record.latencyMs,
      uptimeRatio,
      lastSuccessAt: record.lastSuccessAt,
      lastErrorAt: record.lastErrorAt,
      lastErrorMessage: record.lastErrorMessage,
      consecutiveFailures: record.consecutiveFailures,
      totalSuccesses: record.totalSuccesses,
      totalFailures: record.totalFailures,
      score: this.computeScore(record),
    };
  }

  /**
   * Normalise a relay URL.
   */
  private normaliseUrl(url: string): string {
    return url.trim().replace(/\/+$/, '');
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

const relayManager = new RelayManager();
export default relayManager;
