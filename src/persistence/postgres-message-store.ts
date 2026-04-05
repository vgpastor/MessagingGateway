import { getLogger } from '../core/logger/logger.port.js';
import type { UnifiedEnvelope } from '../core/messaging/unified-envelope.js';
import type {
  MessageStorePort,
  MessageQuery,
  MessageQueryResult,
  MessageStats,
  ConversationContextOptions,
  ConversationContext,
} from './message-store.port.js';
import { toUTC, nowUTC, formatContentForAI, extractPreview, parseJsonColumnRequired, parseJsonColumn } from './message-store.utils.js';

type PgPool = import('pg').Pool;

/**
 * PostgreSQL-based message store using the `pg` driver.
 * Lazy-loads `pg` so it's only required when STORAGE_DRIVER=postgres.
 */
export class PostgresMessageStore implements MessageStorePort {
  private pool!: PgPool;
  private readonly connectionString: string;

  constructor(connectionString: string) {
    this.connectionString = connectionString;
  }

  async init(): Promise<void> {
    try {
      const { Pool } = await import('pg');
      this.pool = new Pool({ connectionString: this.connectionString });

      // Verify connection
      const client = await this.pool.connect();
      client.release();

      // Run migrations
      const { MigrationRunner } = await import('./migrations/migration-runner.js');
      const { PostgresMigrationAdapter } = await import('./migrations/adapters/postgres-migration.adapter.js');
      const { resolveMigrationScriptsDir } = await import('./migrations/resolve-scripts-dir.js');
      const runner = new MigrationRunner({
        scriptsDir: resolveMigrationScriptsDir('postgres'),
        adapter: new PostgresMigrationAdapter(this.pool),
        logger: getLogger().child({ module: 'migrations:postgres' }),
      });
      await runner.run();

      getLogger().info('PostgreSQL message store initialized');
    } catch (err) {
      getLogger().error('Failed to initialize PostgreSQL message store', {
        error: err instanceof Error ? err.message : String(err),
        hint: 'Install pg: npm install pg && npm install -D @types/pg',
      });
      throw err;
    }
  }

  async save(envelope: UnifiedEnvelope): Promise<void> {
    if (!this.pool) return;

    const preview = extractPreview(envelope);

    await this.pool.query(
      `INSERT INTO messages (
        id, account_id, channel, direction, conversation_id,
        sender_id, sender_name, recipient_id,
        content_type, content_preview, content_json,
        context_json, channel_details_json, gateway_json,
        timestamp, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      ON CONFLICT (id) DO UPDATE SET
        content_json = EXCLUDED.content_json,
        content_preview = EXCLUDED.content_preview,
        context_json = EXCLUDED.context_json,
        channel_details_json = EXCLUDED.channel_details_json,
        gateway_json = EXCLUDED.gateway_json`,
      [
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
      ],
    );
  }

  async query(filters: MessageQuery): Promise<MessageQueryResult> {
    if (!this.pool) return { messages: [], total: 0, limit: 50, offset: 0 };

    const { where, params } = this.buildWhere(filters);
    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;

    const countRes = await this.pool.query(`SELECT COUNT(*)::int as total FROM messages ${where}`, params);
    const total = countRes.rows[0].total;

    const idx = params.length;
    const rows = await this.pool.query(
      `SELECT * FROM messages ${where} ORDER BY timestamp DESC LIMIT $${idx + 1} OFFSET $${idx + 2}`,
      [...params, limit, offset],
    );

    return {
      messages: rows.rows.map((r) => this.rowToEnvelope(r)),
      total,
      limit,
      offset,
    };
  }

  async findById(messageId: string): Promise<UnifiedEnvelope | undefined> {
    if (!this.pool) return undefined;
    const res = await this.pool.query('SELECT * FROM messages WHERE id = $1', [messageId]);
    return res.rows.length > 0 ? this.rowToEnvelope(res.rows[0]) : undefined;
  }

  async count(filters?: Partial<MessageQuery>): Promise<number> {
    if (!this.pool) return 0;
    if (!filters || Object.keys(filters).length === 0) {
      const res = await this.pool.query('SELECT COUNT(*)::int as total FROM messages');
      return res.rows[0].total;
    }
    const { where, params } = this.buildWhere(filters as MessageQuery);
    const res = await this.pool.query(`SELECT COUNT(*)::int as total FROM messages ${where}`, params);
    return res.rows[0].total;
  }

  async search(
    query: string,
    options?: { accountId?: string; limit?: number; offset?: number },
  ): Promise<MessageQueryResult> {
    if (!this.pool) return { messages: [], total: 0, limit: 50, offset: 0 };

    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    let idx = 1;
    let where = `WHERE search_vector @@ plainto_tsquery($${idx})`;
    const params: unknown[] = [query];

    if (options?.accountId) {
      where += ` AND account_id = $${++idx}`;
      params.push(options.accountId);
    }

    const countRes = await this.pool.query(`SELECT COUNT(*)::int as total FROM messages ${where}`, params);
    const total = countRes.rows[0].total;

    const limitIdx = params.length + 1;
    const rows = await this.pool.query(
      `SELECT *, ts_rank(search_vector, plainto_tsquery($1)) as rank FROM messages ${where} ORDER BY rank DESC LIMIT $${limitIdx} OFFSET $${limitIdx + 1}`,
      [...params, limit, offset],
    );

    return {
      messages: rows.rows.map((r) => this.rowToEnvelope(r)),
      total,
      limit,
      offset,
    };
  }

  async getStats(options?: { accountId?: string; since?: Date; until?: Date }): Promise<MessageStats> {
    if (!this.pool) {
      return { totalMessages: 0, byChannel: {}, byContentType: {}, byDirection: {}, topConversations: [], byHour: new Array<number>(24).fill(0) };
    }

    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 0;

    if (options?.accountId) { conditions.push(`account_id = $${++idx}`); params.push(options.accountId); }
    if (options?.since) { conditions.push(`timestamp >= $${++idx}`); params.push(toUTC(options.since)); }
    if (options?.until) { conditions.push(`timestamp <= $${++idx}`); params.push(toUTC(options.until)); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const [totalRes, channelRes, typeRes, dirRes, convRes, hourRes] = await Promise.all([
      this.pool.query(`SELECT COUNT(*)::int as total FROM messages ${where}`, params),
      this.pool.query(`SELECT channel, COUNT(*)::int as cnt FROM messages ${where} GROUP BY channel`, params),
      this.pool.query(`SELECT content_type, COUNT(*)::int as cnt FROM messages ${where} GROUP BY content_type`, params),
      this.pool.query(`SELECT direction, COUNT(*)::int as cnt FROM messages ${where} GROUP BY direction`, params),
      this.pool.query(
        `SELECT conversation_id, COUNT(*)::int as cnt, MAX(content_preview) as last_preview FROM messages ${where} GROUP BY conversation_id ORDER BY cnt DESC LIMIT 10`,
        params,
      ),
      this.pool.query(
        `SELECT EXTRACT(HOUR FROM timestamp::timestamptz AT TIME ZONE 'UTC')::int as hour, COUNT(*)::int as cnt FROM messages ${where} GROUP BY hour`,
        params,
      ),
    ]);

    const byChannel: Record<string, number> = {};
    for (const r of channelRes.rows) byChannel[r.channel] = r.cnt;

    const byContentType: Record<string, number> = {};
    for (const r of typeRes.rows) byContentType[r.content_type] = r.cnt;

    const byDirection: Record<string, number> = {};
    for (const r of dirRes.rows) byDirection[r.direction] = r.cnt;

    const topConversations = convRes.rows.map((r) => ({
      conversationId: r.conversation_id,
      count: r.cnt,
      lastMessage: r.last_preview ?? undefined,
    }));

    const byHour: number[] = new Array<number>(24).fill(0);
    for (const r of hourRes.rows) byHour[r.hour] = r.cnt;

    return {
      totalMessages: totalRes.rows[0].total,
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
    if (!this.pool) {
      return { conversationId, participantCount: 0, participants: [], totalMessages: 0, messages: [] };
    }

    const limit = options?.limit ?? 50;
    const includeMedia = options?.includeMedia ?? true;
    const format = options?.format ?? 'openai';

    const conditions = ['conversation_id = $1'];
    const params: unknown[] = [conversationId];
    let idx = 1;

    if (options?.accountId) { conditions.push(`account_id = $${++idx}`); params.push(options.accountId); }
    if (options?.since) { conditions.push(`timestamp >= $${++idx}`); params.push(toUTC(options.since)); }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const limitIdx = idx + 1;

    const [totalRes, participantRes, rowsRes] = await Promise.all([
      this.pool.query(`SELECT COUNT(*)::int as total FROM messages ${where}`, params),
      this.pool.query(
        `SELECT sender_id, sender_name, COUNT(*)::int as cnt FROM messages ${where} GROUP BY sender_id, sender_name ORDER BY cnt DESC`,
        params,
      ),
      this.pool.query(
        `SELECT * FROM (SELECT * FROM messages ${where} ORDER BY timestamp DESC LIMIT $${limitIdx}) sub ORDER BY timestamp ASC`,
        [...params, limit],
      ),
    ]);

    const participants = participantRes.rows.map((p) => ({
      id: p.sender_id,
      name: p.sender_name ?? p.sender_id,
      messageCount: p.cnt,
    }));

    const envelopes = rowsRes.rows.map((r) => this.rowToEnvelope(r));

    const messages = envelopes.map((env) => ({
      role: (env.direction === 'outbound' ? 'assistant' : 'user') as 'user' | 'assistant' | 'system',
      name: env.sender.displayName ?? env.sender.id,
      content: formatContentForAI(env, includeMedia),
      timestamp: typeof env.timestamp === 'string' ? env.timestamp : new Date(env.timestamp).toISOString(),
      type: env.content.type,
      id: env.id,
    }));

    // Try to get group name from channel details
    const lastRow = rowsRes.rows[rowsRes.rows.length - 1];
    let groupName: string | undefined;
    if (lastRow?.channel_details_json) {
      try { groupName = (parseJsonColumn(lastRow.channel_details_json as string | null) as { groupName?: string } | undefined)?.groupName; } catch { /* */ }
    }

    const result: ConversationContext = {
      conversationId,
      groupName,
      participantCount: participants.length,
      participants,
      totalMessages: totalRes.rows[0].total,
      messages,
    };

    if (format === 'raw') {
      result.envelopes = envelopes;
    }

    return result;
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
    }
  }

  // ── Private helpers ────────────────────────────────────────────

  private buildWhere(filters: MessageQuery): { where: string; params: unknown[] } {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 0;

    if (filters.accountId) { conditions.push(`account_id = $${++idx}`); params.push(filters.accountId); }
    if (filters.channel) { conditions.push(`channel = $${++idx}`); params.push(filters.channel); }
    if (filters.conversationId) { conditions.push(`conversation_id = $${++idx}`); params.push(filters.conversationId); }
    if (filters.senderId) { conditions.push(`sender_id = $${++idx}`); params.push(filters.senderId); }
    if (filters.contentType) { conditions.push(`content_type = $${++idx}`); params.push(filters.contentType); }
    if (filters.direction) { conditions.push(`direction = $${++idx}`); params.push(filters.direction); }
    if (filters.since) { conditions.push(`timestamp >= $${++idx}`); params.push(toUTC(filters.since)); }
    if (filters.until) { conditions.push(`timestamp <= $${++idx}`); params.push(toUTC(filters.until)); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return { where, params };
  }

  private rowToEnvelope(row: Record<string, unknown>): UnifiedEnvelope {
    const ts = row.timestamp;
    return {
      id: row.id as string,
      accountId: row.account_id as string,
      channel: row.channel,
      direction: row.direction,
      timestamp: ts instanceof Date ? ts : new Date(ts as string),
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
