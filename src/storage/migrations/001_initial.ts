/**
 * 001_initial.ts - Initial database schema migration for Jisr.
 *
 * Creates all foundational tables:
 *   - contacts       : Known peer identities with trust levels
 *   - sessions       : Encrypted session state blobs per contact
 *   - messages       : Chat message storage (encrypted + plaintext)
 *   - relay_queue    : Outbound packets queued for offline delivery
 *   - peers          : Ephemeral BLE/mesh peer sightings
 *   - settings       : Arbitrary key-value app settings
 *
 * Indexes are created for the most common query patterns.
 */

export interface Migration {
  /** Monotonically increasing version number for this migration. */
  version: number;
  /** Human-readable label shown in logs. */
  name: string;
  /** SQL statements to apply this migration (executed sequentially). */
  up: string[];
}

const migration: Migration = {
  version: 1,
  name: 'initial_schema',
  up: [
    // ----- contacts ----------------------------------------------------------
    `CREATE TABLE IF NOT EXISTS contacts (
      id              TEXT    PRIMARY KEY,
      ed25519_pubkey  TEXT    NOT NULL UNIQUE,
      display_name    TEXT,
      trust_level     TEXT    DEFAULT 'tofu'
                              CHECK(trust_level IN ('verified','tofu','untrusted')),
      added_at        INTEGER NOT NULL,
      last_seen_at    INTEGER
    );`,

    // ----- sessions ----------------------------------------------------------
    `CREATE TABLE IF NOT EXISTS sessions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id  TEXT    NOT NULL REFERENCES contacts(id),
      session_blob BLOB   NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );`,

    // ----- messages ----------------------------------------------------------
    `CREATE TABLE IF NOT EXISTS messages (
      id                TEXT    PRIMARY KEY,
      conversation_id   TEXT    NOT NULL,
      sender_id         TEXT    NOT NULL,
      content_encrypted BLOB,
      content_plaintext TEXT,
      timestamp         INTEGER NOT NULL,
      status            TEXT    DEFAULT 'pending'
                                CHECK(status IN ('pending','sent','delivered','read')),
      transport         TEXT    CHECK(transport IN ('ble','mesh','nostr','local'))
    );`,

    // ----- relay_queue -------------------------------------------------------
    `CREATE TABLE IF NOT EXISTS relay_queue (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      msg_id      BLOB    NOT NULL,
      dst_id      BLOB    NOT NULL,
      packet_data BLOB    NOT NULL,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL
    );`,

    // ----- peers -------------------------------------------------------------
    `CREATE TABLE IF NOT EXISTS peers (
      peer_id       TEXT    PRIMARY KEY,
      last_seen_at  INTEGER NOT NULL,
      rssi          INTEGER,
      hop_count     INTEGER DEFAULT 0
    );`,

    // ----- settings ----------------------------------------------------------
    `CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );`,

    // ----- indexes -----------------------------------------------------------

    // Messages are most frequently queried by conversation, ordered by time.
    `CREATE INDEX IF NOT EXISTS idx_messages_conversation_ts
      ON messages(conversation_id, timestamp);`,

    // Contact lookup by public key (used during handshake / verification).
    `CREATE INDEX IF NOT EXISTS idx_contacts_pubkey
      ON contacts(ed25519_pubkey);`,

    // Relay queue scanned by destination when a peer comes online.
    `CREATE INDEX IF NOT EXISTS idx_relay_queue_dst
      ON relay_queue(dst_id);`,

    // Relay queue pruning by expiry time.
    `CREATE INDEX IF NOT EXISTS idx_relay_queue_expires
      ON relay_queue(expires_at);`,
  ],
};

export default migration;
