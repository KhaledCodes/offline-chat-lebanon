/**
 * ContactStore.ts - Contact CRUD operations for Jisr.
 *
 * Manages the `contacts` table which stores known peer identities along
 * with their Ed25519 public keys and trust levels.
 *
 * Trust model follows TOFU (Trust On First Use):
 *   - 'tofu'       : Default -- accepted on first encounter.
 *   - 'verified'   : User has explicitly verified the key (e.g. QR scan).
 *   - 'untrusted'  : User has explicitly marked this contact as untrusted.
 */

import Database from './Database';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TrustLevel = 'verified' | 'tofu' | 'untrusted';

export interface Contact {
  id: string;
  ed25519Pubkey: string;
  displayName: string | null;
  trustLevel: TrustLevel;
  addedAt: number;
  lastSeenAt: number | null;
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function rowToContact(row: Record<string, unknown>): Contact {
  return {
    id: row.id as string,
    ed25519Pubkey: row.ed25519_pubkey as string,
    displayName: (row.display_name as string | null) ?? null,
    trustLevel: row.trust_level as TrustLevel,
    addedAt: row.added_at as number,
    lastSeenAt: (row.last_seen_at as number | null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// ContactStore
// ---------------------------------------------------------------------------

class ContactStore {
  // -----------------------------------------------------------------------
  // Write operations
  // -----------------------------------------------------------------------

  /**
   * Insert or replace a contact.
   *
   * Uses INSERT OR REPLACE so upserting an existing contact (same `id`) is
   * safe and idempotent.
   */
  async saveContact(contact: Contact): Promise<void> {
    const db = Database.getDb();

    db.execute(
      `INSERT OR REPLACE INTO contacts
        (id, ed25519_pubkey, display_name, trust_level, added_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?);`,
      [
        contact.id,
        contact.ed25519Pubkey,
        contact.displayName ?? null,
        contact.trustLevel,
        contact.addedAt,
        contact.lastSeenAt ?? null,
      ],
    );
  }

  /**
   * Update the trust level of a contact.
   */
  async updateTrustLevel(id: string, level: TrustLevel): Promise<void> {
    const db = Database.getDb();

    db.execute(
      'UPDATE contacts SET trust_level = ? WHERE id = ?;',
      [level, id],
    );
  }

  /**
   * Update the `last_seen_at` timestamp to the current time.
   */
  async updateLastSeen(id: string): Promise<void> {
    const db = Database.getDb();

    db.execute(
      'UPDATE contacts SET last_seen_at = ? WHERE id = ?;',
      [Date.now(), id],
    );
  }

  /**
   * Permanently delete a contact by id.
   *
   * Note: this does NOT cascade-delete associated sessions.  If foreign-key
   * enforcement is on, the caller must remove sessions first or the delete
   * will fail with a constraint violation.
   */
  async deleteContact(id: string): Promise<void> {
    const db = Database.getDb();
    db.execute('DELETE FROM contacts WHERE id = ?;', [id]);
  }

  // -----------------------------------------------------------------------
  // Read operations
  // -----------------------------------------------------------------------

  /**
   * Retrieve a single contact by primary key, or null if not found.
   */
  async getContact(id: string): Promise<Contact | null> {
    const db = Database.getDb();

    const result = db.execute(
      'SELECT * FROM contacts WHERE id = ?;',
      [id],
    );

    if (!result.rows || result.rows.length === 0) {
      return null;
    }

    return rowToContact(result.rows.item(0) as Record<string, unknown>);
  }

  /**
   * Look up a contact by their Ed25519 public key.
   *
   * This is the primary lookup path during BLE handshakes where only the
   * public key is known.
   */
  async getContactByPubKey(pubkey: string): Promise<Contact | null> {
    const db = Database.getDb();

    const result = db.execute(
      'SELECT * FROM contacts WHERE ed25519_pubkey = ?;',
      [pubkey],
    );

    if (!result.rows || result.rows.length === 0) {
      return null;
    }

    return rowToContact(result.rows.item(0) as Record<string, unknown>);
  }

  /**
   * Return all contacts, ordered alphabetically by display name (nulls last).
   */
  async getAllContacts(): Promise<Contact[]> {
    const db = Database.getDb();

    const result = db.execute(
      `SELECT * FROM contacts
       ORDER BY
         CASE WHEN display_name IS NULL THEN 1 ELSE 0 END,
         display_name ASC;`,
    );

    if (!result.rows || result.rows.length === 0) {
      return [];
    }

    const contacts: Contact[] = [];
    for (let i = 0; i < result.rows.length; i++) {
      contacts.push(rowToContact(result.rows.item(i) as Record<string, unknown>));
    }
    return contacts;
  }
}

/** Singleton instance. */
const contactStore = new ContactStore();
export default contactStore;
