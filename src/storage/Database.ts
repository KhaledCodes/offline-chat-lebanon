/**
 * Database.ts - SQLite initialization and migration runner for Jisr.
 *
 * Uses op-sqlite (JSI-based) for synchronous, zero-bridge SQLite access on
 * both iOS and Android.
 *
 * Call `Database.initialize()` once at app startup.  Subsequent calls are
 * safe no-ops.  After initialization, obtain the raw DB handle with
 * `Database.getDb()` for direct queries in stores.
 *
 * Migrations are tracked via a `schema_version` table that records the
 * highest applied version.  New migrations are applied sequentially on
 * each startup.
 */

import { open, type DB } from '@op-engineering/op-sqlite';
import initialMigration, { type Migration } from './migrations/001_initial';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** SQLite database file name (stored in the app's default documents dir). */
const DB_NAME = 'jisr.db';

// ---------------------------------------------------------------------------
// All registered migrations, ordered by version.
// ---------------------------------------------------------------------------

const MIGRATIONS: Migration[] = [
  initialMigration,
  // Future migrations are appended here.
];

// ---------------------------------------------------------------------------
// Database singleton
// ---------------------------------------------------------------------------

class Database {
  private static _db: DB | null = null;
  private static _initialized = false;

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Open (or create) the database and run any pending migrations.
   *
   * Safe to call multiple times -- subsequent invocations are no-ops.
   */
  static async initialize(): Promise<void> {
    if (Database._initialized) {
      return;
    }

    // Open the database.  op-sqlite resolves the platform-appropriate
    // directory automatically when only a filename is provided.
    const db = open({ name: DB_NAME });

    // Enable WAL mode for better concurrent read/write performance.
    db.execute('PRAGMA journal_mode = WAL;');

    // Enable foreign key enforcement (off by default in SQLite).
    db.execute('PRAGMA foreign_keys = ON;');

    Database._db = db;

    // Ensure the schema_version bookkeeping table exists.
    Database.ensureVersionTable();

    // Apply any outstanding migrations.
    Database.runPendingMigrations();

    Database._initialized = true;
  }

  /**
   * Return the raw DB handle.
   *
   * @throws If `initialize()` has not been called yet.
   */
  static getDb(): DB {
    if (!Database._db) {
      throw new Error(
        'Database has not been initialized. Call Database.initialize() first.',
      );
    }
    return Database._db;
  }

  /**
   * Apply a single migration inside a transaction.
   *
   * Exposed publicly so that test harnesses or dev tools can apply
   * individual migrations.  In normal operation `initialize()` handles
   * this automatically.
   */
  static runMigration(migration: Migration): void {
    const db = Database.getDb();

    db.execute('BEGIN TRANSACTION;');
    try {
      for (const sql of migration.up) {
        db.execute(sql);
      }

      // Record the new version.
      db.execute(
        'INSERT OR REPLACE INTO schema_version (id, version, applied_at) VALUES (1, ?, ?);',
        [migration.version, Date.now()],
      );

      db.execute('COMMIT;');
    } catch (error) {
      db.execute('ROLLBACK;');
      throw error;
    }
  }

  /**
   * Close the database and reset state.  Primarily useful in tests.
   */
  static close(): void {
    if (Database._db) {
      Database._db.close();
      Database._db = null;
    }
    Database._initialized = false;
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Create the `schema_version` table if it does not exist.
   */
  private static ensureVersionTable(): void {
    const db = Database.getDb();
    db.execute(
      `CREATE TABLE IF NOT EXISTS schema_version (
        id         INTEGER PRIMARY KEY CHECK (id = 1),
        version    INTEGER NOT NULL DEFAULT 0,
        applied_at INTEGER NOT NULL
      );`,
    );
  }

  /**
   * Return the current schema version (0 if no migration has ever run).
   */
  private static getCurrentVersion(): number {
    const db = Database.getDb();
    const result = db.execute(
      'SELECT version FROM schema_version WHERE id = 1;',
    );

    if (result.rows && result.rows.length > 0) {
      const row = result.rows.item(0);
      return (row as { version: number }).version;
    }
    return 0;
  }

  /**
   * Run all migrations whose version exceeds the current schema version,
   * in ascending order.
   */
  private static runPendingMigrations(): void {
    const currentVersion = Database.getCurrentVersion();

    // Sort defensively (migrations should already be ordered).
    const pending = MIGRATIONS
      .filter(m => m.version > currentVersion)
      .sort((a, b) => a.version - b.version);

    for (const migration of pending) {
      Database.runMigration(migration);
    }
  }
}

export default Database;
export type { Migration };
