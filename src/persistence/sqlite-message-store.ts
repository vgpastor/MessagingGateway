import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getLogger } from '../core/logger/logger.port.js';
import type { UnifiedEnvelope } from '../core/messaging/unified-envelope.js';
import type { MessageStorePort, MessageQuery, MessageQueryResult, MessageStats } from './message-store.port.js';

/**
 * SQLite-based message store using better-sqlite3.
 * Lazy-loads better-sqlite3 so it's only required when persistence is enabled.
 */
export class SqliteMessageStore implements MessageStorePort {
  private db: any; // better-sqlite3 Database (lazily loaded)
  private readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  async init(): Promise<void> {
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    try {
      const Database = (await import('better-sqlite3')).default;
      this.db = new Database(this.dbPath);
      this.db.pragma('journal_mode = WAL');
      // Force UTC for all datetime functions (strftime, etc.)
      this.db.pragma('timezone = UTC');
      this.createTables();
      getLogger().info('Message store initialized', { path: this.dbPath });
    } catch (err) {
      getLogger().error('Failed to initialize message store', {
        path: this.dbPath,
        error: err instanceof Error ? err.message : String(err),
        hint: 'Install better-sqlite3: npm install better-sqlite3',
      });
      throw err;
    }
  }

  async save(envelope: UnifiedEnvelope): Promise<void> {
    if (!this.db) return;

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO messages (
        id, account_id, channel, direction, conversation_id,
        sender_id, sender_name, recipient_id,
        content_type, content_preview, content_json,
        context_json, channel_details_json, gateway_json,
        timestamp, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const preview = this.extractPreview(envelope);

    stmt.run(
      envelope.id,
      envelope.accountId,
      envelope.channel,
      envelope.direction,
      envelope.conversationId,
      envelope.sender.id,
      envelope.sender.displayName ?? null,
      envelope.recipient.id,
      envelope.content.type,
      preview,
      JSON.stringify(envelope.content),
      envelope.context ? JSON.stringify(envelope.context) : null,
      envelope.channelDetails ? JSON.stringify(envelope.channelDetails) : null,
      JSON.stringify(envelope.gateway),
      toUTC(envelope.timestamp),
      nowUTC(),
    );
  }

  async query(filters: MessageQuery): Promise<MessageQueryResult> {
    if (!this.db) return { messages: [], total: 0, limit: 50, offset: 0 };

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.accountId) { conditions.push('account_id = ?'); params.push(filters.accountId); }
    if (filters.channel) { conditions.push('channel = ?'); params.push(filters.channel); }
    if (filters.conversationId) { conditions.push('conversation_id = ?'); params.push(filters.conversationId); }
    if (filters.senderId) { conditions.push('sender_id = ?'); params.push(filters.senderId); }
    if (filters.contentType) { conditions.push('content_type = ?'); params.push(filters.contentType); }
    if (filters.direction) { conditions.push('direction = ?'); params.push(filters.direction); }
    if (filters.since) { conditions.push('timestamp >= ?'); params.push(toUTC(filters.since)); }
    if (filters.until) { conditions.push('timestamp <= ?'); params.push(toUTC(filters.until)); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;

    const countRow = this.db.prepare(`SELECT COUNT(*) as total FROM messages ${where}`).get(...params) as { total: number };
    const rows = this.db.prepare(`SELECT * FROM messages ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as any[];

    return {
      messages: rows.map((r) => this.rowToEnvelope(r)),
      total: countRow.total,
      limit,
      offset,
    };
  }

  async findById(messageId: string): Promise<UnifiedEnvelope | undefined> {
    if (!this.db) return undefined;
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as any;
    return row ? this.rowToEnvelope(row) : undefined;
  }

  async count(filters?: Partial<MessageQuery>): Promise<number> {
    if (!this.db) return 0;
    if (!filters) {
      return (this.db.prepare('SELECT COUNT(*) as total FROM messages').get() as { total: number }).total;
    }
    const result = await this.query({ ...filters, limit: 0 });
    return result.total;
  }

  async search(query: string, options?: { accountId?: string; limit?: number; offset?: number }): Promise<MessageQueryResult> {
    if (!this.db) return { messages: [], total: 0, limit: 50, offset: 0 };

    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    let where = 'messages_fts MATCH ?';
    const params: unknown[] = [query];

    if (options?.accountId) {
      where += ' AND m.account_id = ?';
      params.push(options.accountId);
    }

    const countRow = this.db.prepare(
      `SELECT COUNT(*) as total FROM messages_fts f JOIN messages m ON f.id = m.id WHERE ${where}`,
    ).get(...params) as { total: number };

    const rows = this.db.prepare(
      `SELECT m.* FROM messages_fts f JOIN messages m ON f.id = m.id WHERE ${where} ORDER BY rank LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as any[];

    return {
      messages: rows.map((r) => this.rowToEnvelope(r)),
      total: countRow.total,
      limit,
      offset,
    };
  }

  async getStats(options?: { accountId?: string; since?: Date; until?: Date }): Promise<MessageStats> {
    if (!this.db) {
      return { totalMessages: 0, byChannel: {}, byContentType: {}, byDirection: {}, topConversations: [], byHour: new Array<number>(24).fill(0) };
    }

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options?.accountId) { conditions.push('account_id = ?'); params.push(options.accountId); }
    if (options?.since) { conditions.push('timestamp >= ?'); params.push(toUTC(options.since)); }
    if (options?.until) { conditions.push('timestamp <= ?'); params.push(toUTC(options.until)); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const totalRow = this.db.prepare(`SELECT COUNT(*) as total FROM messages ${where}`).get(...params) as { total: number };

    const channelRows = this.db.prepare(`SELECT channel, COUNT(*) as cnt FROM messages ${where} GROUP BY channel`).all(...params) as Array<{ channel: string; cnt: number }>;
    const byChannel: Record<string, number> = {};
    for (const r of channelRows) { byChannel[r.channel] = r.cnt; }

    const typeRows = this.db.prepare(`SELECT content_type, COUNT(*) as cnt FROM messages ${where} GROUP BY content_type`).all(...params) as Array<{ content_type: string; cnt: number }>;
    const byContentType: Record<string, number> = {};
    for (const r of typeRows) { byContentType[r.content_type] = r.cnt; }

    const dirRows = this.db.prepare(`SELECT direction, COUNT(*) as cnt FROM messages ${where} GROUP BY direction`).all(...params) as Array<{ direction: string; cnt: number }>;
    const byDirection: Record<string, number> = {};
    for (const r of dirRows) { byDirection[r.direction] = r.cnt; }

    const convRows = this.db.prepare(
      `SELECT conversation_id, COUNT(*) as cnt, MAX(content_preview) as last_preview FROM messages ${where} GROUP BY conversation_id ORDER BY cnt DESC LIMIT 10`,
    ).all(...params) as Array<{ conversation_id: string; cnt: number; last_preview: string | null }>;
    const topConversations = convRows.map((r) => ({
      conversationId: r.conversation_id,
      count: r.cnt,
      lastMessage: r.last_preview ?? undefined,
    }));

    const hourRows = this.db.prepare(
      `SELECT CAST(strftime('%H', timestamp, 'utc') AS INTEGER) as hour, COUNT(*) as cnt FROM messages ${where} GROUP BY hour`,
    ).all(...params) as Array<{ hour: number; cnt: number }>;
    const byHour: number[] = new Array<number>(24).fill(0);
    for (const r of hourRows) { byHour[r.hour] = r.cnt; }

    return {
      totalMessages: totalRow.total,
      byChannel,
      byContentType,
      byDirection,
      topConversations,
      byHour,
    };
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        direction TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        sender_name TEXT,
        recipient_id TEXT NOT NULL,
        content_type TEXT NOT NULL,
        content_preview TEXT,
        content_json TEXT NOT NULL,
        context_json TEXT,
        channel_details_json TEXT,
        gateway_json TEXT NOT NULL,
        timestamp TEXT NOT NULL,  -- ISO 8601 UTC (e.g. 2026-04-01T12:00:00.000Z)
        created_at TEXT NOT NULL  -- ISO 8601 UTC
      );

      CREATE INDEX IF NOT EXISTS idx_messages_account ON messages(account_id);
      CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
      CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(content_type);

      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        id, content_preview, sender_name,
        content='messages',
        content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(id, content_preview, sender_name)
        VALUES (new.id, new.content_preview, new.sender_name);
      END;
    `);
  }

  private extractPreview(envelope: UnifiedEnvelope): string | null {
    const c = envelope.content;
    switch (c.type) {
      case 'text': return c.body.substring(0, 200);
      case 'image': return c.caption?.substring(0, 200) ?? '[Image]';
      case 'video': return c.caption?.substring(0, 200) ?? '[Video]';
      case 'audio': return c.isVoiceNote ? '[Voice Note]' : '[Audio]';
      case 'document': return c.fileName;
      case 'location': return `[Location: ${c.latitude},${c.longitude}]`;
      case 'contact': return c.contacts.map((ct) => ct.name).join(', ');
      case 'reaction': return c.emoji;
      case 'poll': return c.question;
      case 'sticker': return '[Sticker]';
      default: return null;
    }
  }

  private rowToEnvelope(row: any): UnifiedEnvelope {
    return {
      id: row.id,
      accountId: row.account_id,
      channel: row.channel,
      direction: row.direction,
      timestamp: row.timestamp,
      conversationId: row.conversation_id,
      sender: { id: row.sender_id, displayName: row.sender_name },
      recipient: { id: row.recipient_id },
      content: JSON.parse(row.content_json),
      context: row.context_json ? JSON.parse(row.context_json) : undefined,
      channelDetails: row.channel_details_json ? JSON.parse(row.channel_details_json) : undefined,
      gateway: JSON.parse(row.gateway_json),
    };
  }
}

// ── UTC helpers ─────────────────────────────────────────────────
// ALL dates stored as ISO 8601 with explicit Z suffix (UTC).
// External systems handle timezone conversion.

/** Convert any date-like value to ISO 8601 UTC string */
function toUTC(value: string | Date | number): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString(); // Always ends with Z (UTC)
}

/** Current time as ISO 8601 UTC string */
function nowUTC(): string {
  return new Date().toISOString();
}
