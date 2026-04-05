import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type Database from 'better-sqlite3';
import { getLogger } from '../core/logger/logger.port.js';
import type { UnifiedEnvelope } from '../core/messaging/unified-envelope.js';
import type {
  FullMessageStorePort,
  MessageQuery,
  MessageQueryResult,
  MessageStats,
  SearchOptions,
  StatsOptions,
  ConversationHistoryOptions,
  RawConversationHistory,
} from '../core/persistence/message-store.port.js';
import { toUTC, nowUTC, extractPreview, parseJsonColumnRequired, parseJsonColumn } from '../core/persistence/message-store.utils.js';

/**
 * SQLite-based message store using better-sqlite3.
 * Lazy-loads better-sqlite3 so it's only required when persistence is enabled.
 */
export class SqliteMessageStore implements FullMessageStorePort {
  private db: Database.Database | null = null;
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
      const DatabaseConstructor = (await import('better-sqlite3')).default;
      this.db = new DatabaseConstructor(this.dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('timezone = UTC');

      getLogger().info('Message store initialized', { path: this.dbPath, driver: 'sqlite' });
    } catch (err) {
      getLogger().error('Failed to initialize message store', {
        path: this.dbPath,
        error: err instanceof Error ? err.message : String(err),
        hint: 'Install better-sqlite3: npm install better-sqlite3',
      });
      throw err;
    }
  }

  /** Run migrations — called externally by the factory after init() */
  async runMigrations(): Promise<void> {
    const db = this.requireDb();
    const { MigrationRunner } = await import('./migrations/migration-runner.js');
    const { SqliteMigrationAdapter } = await import('./migrations/adapters/sqlite-migration.adapter.js');
    const { resolveMigrationScriptsDir } = await import('./migrations/resolve-scripts-dir.js');
    const runner = new MigrationRunner({
      scriptsDir: resolveMigrationScriptsDir('sqlite'),
      adapter: new SqliteMigrationAdapter(db),
      logger: getLogger().child({ module: 'migrations:sqlite' }),
    });
    await runner.run();
  }

  async save(envelope: UnifiedEnvelope): Promise<void> {
    const db = this.requireDb();

    const stmt = db.prepare(`
      INSERT OR REPLACE INTO messages (
        id, account_id, channel, direction, conversation_id,
        sender_id, sender_name, recipient_id,
        content_type, content_preview, content_json,
        context_json, channel_details_json, gateway_json,
        timestamp, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const preview = extractPreview(envelope);

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
    const db = this.requireDb();

    const { where, params } = this.buildWhere(filters);
    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;

    const countRow = db.prepare(`SELECT COUNT(*) as total FROM messages ${where}`).get(...params) as { total: number };
    const rows = db.prepare(`SELECT * FROM messages ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);

    return {
      messages: rows.map((r) => this.rowToEnvelope(r as Record<string, unknown>)),
      total: countRow.total,
      limit,
      offset,
    };
  }

  async findById(messageId: string): Promise<UnifiedEnvelope | undefined> {
    const db = this.requireDb();
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    return row ? this.rowToEnvelope(row as Record<string, unknown>) : undefined;
  }

  async count(filters?: Partial<MessageQuery>): Promise<number> {
    const db = this.requireDb();
    if (!filters || Object.keys(filters).length === 0) {
      return (db.prepare('SELECT COUNT(*) as total FROM messages').get() as { total: number }).total;
    }
    const { where, params } = this.buildWhere(filters as MessageQuery);
    return (db.prepare(`SELECT COUNT(*) as total FROM messages ${where}`).get(...params) as { total: number }).total;
  }

  async search(query: string, options?: SearchOptions): Promise<MessageQueryResult> {
    const db = this.requireDb();

    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    let where = 'messages_fts MATCH ?';
    const params: unknown[] = [query];

    if (options?.accountId) {
      where += ' AND m.account_id = ?';
      params.push(options.accountId);
    }

    const countRow = db.prepare(
      `SELECT COUNT(*) as total FROM messages_fts f JOIN messages m ON f.id = m.id WHERE ${where}`,
    ).get(...params) as { total: number };

    const rows = db.prepare(
      `SELECT m.* FROM messages_fts f JOIN messages m ON f.id = m.id WHERE ${where} ORDER BY rank LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset);

    return {
      messages: rows.map((r) => this.rowToEnvelope(r as Record<string, unknown>)),
      total: countRow.total,
      limit,
      offset,
    };
  }

  async getStats(options?: StatsOptions): Promise<MessageStats> {
    const db = this.requireDb();

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options?.accountId) { conditions.push('account_id = ?'); params.push(options.accountId); }
    if (options?.since) { conditions.push('timestamp >= ?'); params.push(toUTC(options.since)); }
    if (options?.until) { conditions.push('timestamp <= ?'); params.push(toUTC(options.until)); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const totalRow = db.prepare(`SELECT COUNT(*) as total FROM messages ${where}`).get(...params) as { total: number };

    const channelRows = db.prepare(`SELECT channel, COUNT(*) as cnt FROM messages ${where} GROUP BY channel`).all(...params) as Array<{ channel: string; cnt: number }>;
    const byChannel: Record<string, number> = {};
    for (const r of channelRows) { byChannel[r.channel] = r.cnt; }

    const typeRows = db.prepare(`SELECT content_type, COUNT(*) as cnt FROM messages ${where} GROUP BY content_type`).all(...params) as Array<{ content_type: string; cnt: number }>;
    const byContentType: Record<string, number> = {};
    for (const r of typeRows) { byContentType[r.content_type] = r.cnt; }

    const dirRows = db.prepare(`SELECT direction, COUNT(*) as cnt FROM messages ${where} GROUP BY direction`).all(...params) as Array<{ direction: string; cnt: number }>;
    const byDirection: Record<string, number> = {};
    for (const r of dirRows) { byDirection[r.direction] = r.cnt; }

    const convRows = db.prepare(
      `SELECT conversation_id, COUNT(*) as cnt, MAX(content_preview) as last_preview FROM messages ${where} GROUP BY conversation_id ORDER BY cnt DESC LIMIT 10`,
    ).all(...params) as Array<{ conversation_id: string; cnt: number; last_preview: string | null }>;
    const topConversations = convRows.map((r) => ({
      conversationId: r.conversation_id,
      count: r.cnt,
      lastMessage: r.last_preview ?? undefined,
    }));

    const hourRows = db.prepare(
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

  async getConversationHistory(
    conversationId: string,
    options?: ConversationHistoryOptions,
  ): Promise<RawConversationHistory> {
    const db = this.requireDb();

    const limit = options?.limit ?? 50;
    const conditions = ['conversation_id = ?'];
    const params: unknown[] = [conversationId];

    if (options?.accountId) { conditions.push('account_id = ?'); params.push(options.accountId); }
    if (options?.since) { conditions.push('timestamp >= ?'); params.push(toUTC(options.since)); }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const totalRow = db.prepare(`SELECT COUNT(*) as total FROM messages ${where}`).get(...params) as { total: number };

    const participantRows = db.prepare(
      `SELECT sender_id, sender_name, COUNT(*) as cnt FROM messages ${where} GROUP BY sender_id ORDER BY cnt DESC`,
    ).all(...params) as Array<{ sender_id: string; sender_name: string | null; cnt: number }>;

    const participants = participantRows.map((p) => ({
      id: p.sender_id,
      name: p.sender_name ?? p.sender_id,
      messageCount: p.cnt,
    }));

    const rows = db.prepare(
      `SELECT * FROM (SELECT * FROM messages ${where} ORDER BY timestamp DESC LIMIT ?) ORDER BY timestamp ASC`,
    ).all(...params, limit);

    const envelopes = rows.map((r) => this.rowToEnvelope(r as Record<string, unknown>));

    // Extract group name from last message's channel details
    const lastRow = rows[rows.length - 1] as Record<string, unknown> | undefined;
    let groupName: string | undefined;
    if (lastRow?.channel_details_json) {
      try {
        groupName = parseJsonColumn<{ groupName?: string }>(lastRow.channel_details_json as string)?.groupName;
      } catch { /* non-critical */ }
    }

    return {
      conversationId,
      groupName,
      participantCount: participants.length,
      participants,
      totalMessages: totalRow.total,
      envelopes,
    };
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // ── Private helpers ────────────────────────────────────────────

  /** Fail fast if the store was not initialized */
  private requireDb(): Database.Database {
    if (!this.db) {
      throw new Error('SqliteMessageStore not initialized — call init() first');
    }
    return this.db;
  }

  private buildWhere(filters: MessageQuery): { where: string; params: unknown[] } {
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
    return { where, params };
  }

  private rowToEnvelope(row: Record<string, unknown>): UnifiedEnvelope {
    return {
      id: row.id as string,
      accountId: row.account_id as string,
      channel: row.channel,
      direction: row.direction,
      timestamp: new Date(row.timestamp as string),
      conversationId: row.conversation_id as string,
      sender: { id: row.sender_id as string, displayName: row.sender_name as string | undefined },
      recipient: { id: row.recipient_id as string },
      content: parseJsonColumnRequired(row.content_json as string),
      context: parseJsonColumn(row.context_json as string | null) ?? undefined,
      channelDetails: parseJsonColumn(row.channel_details_json as string | null) ?? undefined,
      gateway: parseJsonColumnRequired(row.gateway_json as string),
    } as UnifiedEnvelope;
  }
}
