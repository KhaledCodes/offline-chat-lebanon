/**
 * TransportQueue.ts - Outbound message queue for offline delivery.
 *
 * When no transport (BLE, mesh, Nostr) is currently available for a
 * recipient, messages are persisted to the `relay_queue` SQLite table
 * so they survive app restarts.
 *
 * The queue exposes a flush hook that the TransportManager can invoke
 * whenever a transport becomes available.
 */

import Database from '../storage/Database';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default message TTL in the queue: 24 hours (milliseconds). */
const DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QueuedMessage {
  recipientId: string;
  content: Uint8Array;
  messageId: string;
  queuedAt: number;
}

/** Callback invoked for each message during a flush attempt. */
export type FlushCallback = (msg: QueuedMessage) => Promise<boolean>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a Uint8Array to an ArrayBuffer suitable for SQLite BLOB binding.
 */
function toBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength,
  );
}

/**
 * Convert a database BLOB (ArrayBuffer) back to a Uint8Array.
 */
function fromBuffer(buf: unknown): Uint8Array {
  if (buf instanceof ArrayBuffer) {
    return new Uint8Array(buf);
  }
  if (buf instanceof Uint8Array) {
    return buf;
  }
  // Fallback: treat as empty.
  return new Uint8Array(0);
}

// ---------------------------------------------------------------------------
// TransportQueue
// ---------------------------------------------------------------------------

class TransportQueue {
  private _flushCallback: FlushCallback | null = null;

  // -----------------------------------------------------------------------
  // Core queue operations
  // -----------------------------------------------------------------------

  /**
   * Add a message to the persistent queue.
   *
   * @param recipientId  Destination peer id.
   * @param content      Raw encrypted message bytes.
   * @param messageId    Application-level message identifier.
   */
  enqueue(recipientId: string, content: Uint8Array, messageId: string): void {
    const db = Database.getDb();
    const now = Date.now();

    db.execute(
      `INSERT INTO relay_queue (msg_id, dst_id, packet_data, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?);`,
      [
        messageId,
        recipientId,
        toBuffer(content),
        now,
        now + DEFAULT_EXPIRY_MS,
      ],
    );
  }

  /**
   * Remove and return all queued messages for a specific recipient.
   *
   * Messages that have expired (expires_at < now) are pruned instead of
   * being returned.
   */
  dequeue(recipientId: string): QueuedMessage[] {
    const db = Database.getDb();
    const now = Date.now();

    // Prune expired entries for this recipient.
    db.execute(
      'DELETE FROM relay_queue WHERE dst_id = ? AND expires_at < ?;',
      [recipientId, now],
    );

    // Fetch remaining entries.
    const result = db.execute(
      `SELECT id, msg_id, dst_id, packet_data, created_at
       FROM relay_queue
       WHERE dst_id = ?
       ORDER BY created_at ASC;`,
      [recipientId],
    );

    if (!result.rows || result.rows.length === 0) {
      return [];
    }

    const messages: QueuedMessage[] = [];
    const idsToDelete: number[] = [];

    for (let i = 0; i < result.rows.length; i++) {
      const row = result.rows.item(i) as Record<string, unknown>;
      messages.push({
        recipientId: row.dst_id as string,
        content: fromBuffer(row.packet_data),
        messageId: row.msg_id as string,
        queuedAt: row.created_at as number,
      });
      idsToDelete.push(row.id as number);
    }

    // Delete dequeued rows.
    if (idsToDelete.length > 0) {
      const placeholders = idsToDelete.map(() => '?').join(',');
      db.execute(
        `DELETE FROM relay_queue WHERE id IN (${placeholders});`,
        idsToDelete,
      );
    }

    return messages;
  }

  /**
   * Remove and return all queued messages across all recipients.
   */
  dequeueAll(): QueuedMessage[] {
    const db = Database.getDb();
    const now = Date.now();

    // Prune all expired entries first.
    db.execute(
      'DELETE FROM relay_queue WHERE expires_at < ?;',
      [now],
    );

    const result = db.execute(
      `SELECT id, msg_id, dst_id, packet_data, created_at
       FROM relay_queue
       ORDER BY created_at ASC;`,
    );

    if (!result.rows || result.rows.length === 0) {
      return [];
    }

    const messages: QueuedMessage[] = [];
    const idsToDelete: number[] = [];

    for (let i = 0; i < result.rows.length; i++) {
      const row = result.rows.item(i) as Record<string, unknown>;
      messages.push({
        recipientId: row.dst_id as string,
        content: fromBuffer(row.packet_data),
        messageId: row.msg_id as string,
        queuedAt: row.created_at as number,
      });
      idsToDelete.push(row.id as number);
    }

    // Delete all dequeued rows.
    if (idsToDelete.length > 0) {
      const placeholders = idsToDelete.map(() => '?').join(',');
      db.execute(
        `DELETE FROM relay_queue WHERE id IN (${placeholders});`,
        idsToDelete,
      );
    }

    return messages;
  }

  // -----------------------------------------------------------------------
  // Queue management
  // -----------------------------------------------------------------------

  /**
   * Return the number of messages currently in the queue (excluding expired).
   */
  getSize(): number {
    const db = Database.getDb();
    const now = Date.now();

    const result = db.execute(
      'SELECT COUNT(*) AS cnt FROM relay_queue WHERE expires_at >= ?;',
      [now],
    );

    if (!result.rows || result.rows.length === 0) {
      return 0;
    }

    return (result.rows.item(0) as Record<string, unknown>).cnt as number;
  }

  /**
   * Remove messages older than `maxAge` milliseconds.
   *
   * @param maxAge  Maximum age in milliseconds.
   * @returns       Number of rows deleted.
   */
  prune(maxAge: number): number {
    const db = Database.getDb();
    const cutoff = Date.now() - maxAge;

    const result = db.execute(
      'DELETE FROM relay_queue WHERE created_at < ?;',
      [cutoff],
    );

    return result.rowsAffected ?? 0;
  }

  // -----------------------------------------------------------------------
  // Flush mechanism
  // -----------------------------------------------------------------------

  /**
   * Register a callback that is invoked for each queued message during
   * a flush.  The callback should return `true` if the message was
   * successfully sent (and should be removed from the queue), or `false`
   * to leave it queued.
   */
  onFlush(callback: FlushCallback): void {
    this._flushCallback = callback;
  }

  /**
   * Attempt to deliver all queued messages via the registered flush
   * callback.  Messages that are successfully sent are removed from the
   * queue.  This is called by TransportManager when a transport becomes
   * available.
   *
   * @returns Number of messages successfully flushed.
   */
  async flush(): Promise<number> {
    if (!this._flushCallback) {
      return 0;
    }

    const db = Database.getDb();
    const now = Date.now();

    // Prune expired.
    db.execute('DELETE FROM relay_queue WHERE expires_at < ?;', [now]);

    const result = db.execute(
      `SELECT id, msg_id, dst_id, packet_data, created_at
       FROM relay_queue
       ORDER BY created_at ASC;`,
    );

    if (!result.rows || result.rows.length === 0) {
      return 0;
    }

    let flushed = 0;

    for (let i = 0; i < result.rows.length; i++) {
      const row = result.rows.item(i) as Record<string, unknown>;
      const msg: QueuedMessage = {
        recipientId: row.dst_id as string,
        content: fromBuffer(row.packet_data),
        messageId: row.msg_id as string,
        queuedAt: row.created_at as number,
      };

      try {
        const sent = await this._flushCallback(msg);
        if (sent) {
          db.execute('DELETE FROM relay_queue WHERE id = ?;', [row.id as number]);
          flushed++;
        }
      } catch {
        // Skip this message on error; it will be retried on next flush.
      }
    }

    return flushed;
  }
}

/** Singleton instance. */
const transportQueue = new TransportQueue();
export default transportQueue;
