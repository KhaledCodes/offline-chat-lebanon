/**
 * MessageStore.ts - Message CRUD operations for Jisr.
 *
 * All methods operate against the `messages` table via op-sqlite's
 * synchronous JSI interface.  The async wrappers ensure the public API
 * stays Promise-based so callers can freely `await` without worrying
 * about whether the underlying driver is sync or async.
 */

import Database from './Database';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MessageStatus = 'pending' | 'sent' | 'delivered' | 'read';

export type TransportType = 'ble' | 'mesh' | 'nostr' | 'local';

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  contentEncrypted?: ArrayBuffer | null;
  contentPlaintext?: string | null;
  timestamp: number;
  status: MessageStatus;
  transport?: TransportType | null;
}

export interface Conversation {
  contactId: string;
  displayName: string | null;
  lastMessage: string | null;
  lastTimestamp: number;
  unreadCount: number;
}

// ---------------------------------------------------------------------------
// Row mapping helpers
// ---------------------------------------------------------------------------

/**
 * Map a raw database row object to a typed `Message`.
 */
function rowToMessage(row: Record<string, unknown>): Message {
  return {
    id: row.id as string,
    conversationId: row.conversation_id as string,
    senderId: row.sender_id as string,
    contentEncrypted: row.content_encrypted as ArrayBuffer | null ?? null,
    contentPlaintext: row.content_plaintext as string | null ?? null,
    timestamp: row.timestamp as number,
    status: row.status as MessageStatus,
    transport: (row.transport as TransportType | null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// MessageStore
// ---------------------------------------------------------------------------

class MessageStore {
  // -----------------------------------------------------------------------
  // Write operations
  // -----------------------------------------------------------------------

  /**
   * Insert or replace a message.
   *
   * Uses INSERT OR REPLACE so that re-saving a message with the same `id`
   * (e.g. after a status update that also touches content) is idempotent.
   */
  async saveMessage(msg: Message): Promise<void> {
    const db = Database.getDb();

    db.execute(
      `INSERT OR REPLACE INTO messages
        (id, conversation_id, sender_id, content_encrypted, content_plaintext, timestamp, status, transport)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        msg.id,
        msg.conversationId,
        msg.senderId,
        msg.contentEncrypted ?? null,
        msg.contentPlaintext ?? null,
        msg.timestamp,
        msg.status,
        msg.transport ?? null,
      ],
    );
  }

  /**
   * Update only the delivery status of an existing message.
   */
  async updateStatus(msgId: string, status: MessageStatus): Promise<void> {
    const db = Database.getDb();

    db.execute(
      'UPDATE messages SET status = ? WHERE id = ?;',
      [status, msgId],
    );
  }

  /**
   * Permanently delete a message by id.
   */
  async deleteMessage(msgId: string): Promise<void> {
    const db = Database.getDb();
    db.execute('DELETE FROM messages WHERE id = ?;', [msgId]);
  }

  // -----------------------------------------------------------------------
  // Read operations
  // -----------------------------------------------------------------------

  /**
   * Retrieve messages for a conversation, most-recent-first, with optional
   * cursor-based pagination.
   *
   * @param conversationId  The conversation to query.
   * @param limit           Maximum number of messages to return (default 50).
   * @param before          Unix-ms timestamp upper bound for pagination.
   *                        Only messages with `timestamp < before` are returned.
   */
  async getMessages(
    conversationId: string,
    limit: number = 50,
    before?: number,
  ): Promise<Message[]> {
    const db = Database.getDb();

    let sql: string;
    let params: unknown[];

    if (before !== undefined) {
      sql =
        `SELECT * FROM messages
         WHERE conversation_id = ? AND timestamp < ?
         ORDER BY timestamp DESC
         LIMIT ?;`;
      params = [conversationId, before, limit];
    } else {
      sql =
        `SELECT * FROM messages
         WHERE conversation_id = ?
         ORDER BY timestamp DESC
         LIMIT ?;`;
      params = [conversationId, limit];
    }

    const result = db.execute(sql, params);

    if (!result.rows || result.rows.length === 0) {
      return [];
    }

    const messages: Message[] = [];
    for (let i = 0; i < result.rows.length; i++) {
      messages.push(rowToMessage(result.rows.item(i) as Record<string, unknown>));
    }
    return messages;
  }

  /**
   * Return the single most recent message in a conversation, or null.
   */
  async getLatestMessage(conversationId: string): Promise<Message | null> {
    const db = Database.getDb();

    const result = db.execute(
      `SELECT * FROM messages
       WHERE conversation_id = ?
       ORDER BY timestamp DESC
       LIMIT 1;`,
      [conversationId],
    );

    if (!result.rows || result.rows.length === 0) {
      return null;
    }

    return rowToMessage(result.rows.item(0) as Record<string, unknown>);
  }

  /**
   * Return all messages with status 'pending' (not yet acknowledged by
   * any transport).  Used by TransportManager to retry delivery.
   */
  async getPendingMessages(): Promise<Message[]> {
    const db = Database.getDb();

    const result = db.execute(
      `SELECT * FROM messages
       WHERE status = 'pending'
       ORDER BY timestamp ASC;`,
    );

    if (!result.rows || result.rows.length === 0) {
      return [];
    }

    const messages: Message[] = [];
    for (let i = 0; i < result.rows.length; i++) {
      messages.push(rowToMessage(result.rows.item(i) as Record<string, unknown>));
    }
    return messages;
  }

  /**
   * Return a summary of all conversations, each with the latest message
   * preview and unread count.
   *
   * Conversations are sorted by most-recent activity (descending).
   * The `displayName` is resolved by joining against the `contacts` table
   * using `conversation_id = contacts.id`.
   */
  async getConversations(): Promise<Conversation[]> {
    const db = Database.getDb();

    const result = db.execute(
      `SELECT
         m.conversation_id           AS contact_id,
         c.display_name              AS display_name,
         latest.content_plaintext    AS last_message,
         latest.timestamp            AS last_timestamp,
         COALESCE(unread.cnt, 0)     AS unread_count
       FROM (
         SELECT conversation_id, MAX(timestamp) AS max_ts
         FROM messages
         GROUP BY conversation_id
       ) m
       LEFT JOIN messages latest
         ON latest.conversation_id = m.conversation_id
         AND latest.timestamp = m.max_ts
       LEFT JOIN contacts c
         ON c.id = m.conversation_id
       LEFT JOIN (
         SELECT conversation_id, COUNT(*) AS cnt
         FROM messages
         WHERE status != 'read'
         GROUP BY conversation_id
       ) unread
         ON unread.conversation_id = m.conversation_id
       ORDER BY latest.timestamp DESC;`,
    );

    if (!result.rows || result.rows.length === 0) {
      return [];
    }

    const conversations: Conversation[] = [];
    for (let i = 0; i < result.rows.length; i++) {
      const row = result.rows.item(i) as Record<string, unknown>;
      conversations.push({
        contactId: row.contact_id as string,
        displayName: (row.display_name as string | null) ?? null,
        lastMessage: (row.last_message as string | null) ?? null,
        lastTimestamp: row.last_timestamp as number,
        unreadCount: (row.unread_count as number) ?? 0,
      });
    }
    return conversations;
  }
}

/** Singleton instance. */
const messageStore = new MessageStore();
export default messageStore;
