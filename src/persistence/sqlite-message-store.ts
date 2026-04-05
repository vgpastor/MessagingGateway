import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type Database from 'better-sqlite3';
import { getLogger } from '../core/logger/logger.port.js';
import type { UnifiedEnvelope } from '../core/messaging/unified-envelope.js';
import type { MessageStorePort, MessageQuery, MessageQueryResult, MessageStats, ConversationContext, ConversationContextOptions } from './message-store.port.js';
import { toUTC, nowUTC, formatContentForAI, extractPreview, parseJsonColumnRequired, parseJsonColumn } from './message-store.utils.js';

/**
 * SQLite-based message store using better-sqlite3.
 * Lazy-loads better-sqlite3 so it's only required when persistence is enabled.
 */
export class SqliteMessageStore implements MessageStorePort {
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

      // Run migrations
      const { MigrationRunner } = await import('./migrations/migration-runner.js');
      const { SqliteMigrationAdapter } = await import('./migrations/adapters/sqlite-migration.adapter.js');
      const { resolveMigrationScriptsDir } = await import('./migrations/resolve-scripts-dir.js');
      const runner = new MigrationRunner({
        scriptsDir: resolveMigrationScriptsDir('sqlite'),
        adapter: new SqliteMigrationAdapter(this.db),
        logger: getLogger().child({ module: 'migrations:sqlite' }),
      });
      await runner.run();

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
    if (!this.db) return { messages: [], total: 0, limit: 50, offset: 0 };

    const { where, params } = this.buildWhere(filters);
    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;

    const countRow = this.db.prepare(`SELECT COUNT(*) as total FROM messages ${where}`).get(...params) as { total: number };
    const rows = this.db.prepare(`SELECT * FROM messages ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);

    return {
      messages: rows.map((r) => this.rowToEnvelope(r as Record<string, unknown>)),
      total: countRow.total,
      limit,
      offset,
    };
  }

  async findById(messageId: string): Promise<UnifiedEnvelope | undefined> {
    if (!this.db) return undefined;
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    return row ? this.rowToEnvelope(row as Record<string, unknown>) : undefined;
  }

  async count(filters?: Partial<MessageQuery>): Promise<number> {
    if (!this.db) return 0;
    if (!filters || Object.keys(filters).length === 0) {
      return (this.db.prepare('SELECT COUNT(*) as total FROM messages').get() as { total: number }).total;
    }
    const { where, params } = this.buildWhere(filters as MessageQuery);
    return (this.db.prepare(`SELECT COUNT(*) as total FROM messages ${where}`).get(...params) as { total: number }).total;
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
    ).all(...params, limit, offset);

    return {
      messages: rows.map((r) => this.rowToEnvelope(r as Record<string, unknown>)),
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

  async getConversationContext(
    conversationId: string,
    options?: ConversationContextOptions,
  ): Promise<ConversationContext> {
    const limit = options?.limit ?? 50;
    const includeMedia = options?.includeMedia ?? true;
    const format = options?.format ?? 'openai';

    const conditions = ['conversation_id = ?'];
    const params: unknown[] = [conversationId];

    if (options?.accountId) { conditions.push('account_id = ?'); params.push(options.accountId); }
    if (options?.since) { conditions.push('timestamp >= ?'); params.push(toUTC(options.since)); }

    const where = `WHERE ${conditions.join(' AND ')}`;

    if (!this.db) {
      return { conversationId, participantCount: 0, participants: [], totalMessages: 0, messages: [] };
    }

    const totalRow = this.db.prepare(`SELECT COUNT(*) as total FROM messages ${where}`).get(...params) as { total: number };

    const participantRows = this.db.prepare(
      `SELECT sender_id, sender_name, COUNT(*) as cnt FROM messages ${where} GROUP BY sender_id ORDER BY cnt DESC`,
    ).all(...params) as Array<{ sender_id: string; sender_name: string | null; cnt: number }>;

    const participants = participantRows.map((p) => ({
      id: p.sender_id,
      name: p.sender_name ?? p.sender_id,
      messageCount: p.cnt,
    }));

    const rows = this.db.prepare(
      `SELECT * FROM (SELECT * FROM messages ${where} ORDER BY timestamp DESC LIMIT ?) ORDER BY timestamp ASC`,
    ).all(...params, limit);

    const envelopes = rows.map((r) => this.rowToEnvelope(r as Record<string, unknown>));

    const messages = envelopes.map((env) => ({
      role: (env.direction === 'outbound' ? 'assistant' : 'user') as 'user' | 'assistant' | 'system',
      name: env.sender.displayName ?? env.sender.id,
      content: formatContentForAI(env, includeMedia),
      timestamp: typeof env.timestamp === 'string' ? env.timestamp : new Date(env.timestamp).toISOString(),
      type: env.content.type,
      id: env.id,
    }));

    const lastRow = rows[rows.length - 1] as Record<string, unknown> | undefined;
    let groupName: string | undefined;
    if (lastRow?.channel_details_json) {
      try { groupName = (parseJsonColumn(lastRow.channel_details_json as string) as { groupName?: string } | undefined)?.groupName; } catch { /* */ }
    }

    const result: ConversationContext = {
      conversationId,
      groupName,
      participantCount: participants.length,
      participants,
      totalMessages: totalRow.total,
      messages,
    };

    if (format === 'raw') {
      result.envelopes = envelopes;
    }

    return result;
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // ── Private helpers ────────────────────────────────────────────

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
