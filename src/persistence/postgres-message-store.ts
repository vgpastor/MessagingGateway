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

type PgPool = import('pg').Pool;

/**
 * PostgreSQL-based message store using the `pg` driver.
 * Lazy-loads `pg` so it's only required when STORAGE_DRIVER=postgres.
 */
export class PostgresMessageStore implements FullMessageStorePort {
  private pool: PgPool | null = null;
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

      getLogger().info('PostgreSQL message store initialized');
    } catch (err) {
      getLogger().error('Failed to initialize PostgreSQL message store', {
        error: err instanceof Error ? err.message : String(err),
        hint: 'Install pg: npm install pg && npm install -D @types/pg',
      });
      throw err;
    }
  }

  /** Run migrations — called externally by the factory after init() */
  async runMigrations(): Promise<void> {
    const pool = this.requirePool();
    const { MigrationRunner } = await import('./migrations/migration-runner.js');
    const { PostgresMigrationAdapter } = await import('./migrations/adapters/postgres-migration.adapter.js');
    const { resolveMigrationScriptsDir } = await import('./migrations/resolve-scripts-dir.js');
    const runner = new MigrationRunner({
      scriptsDir: resolveMigrationScriptsDir('postgres'),
      adapter: new PostgresMigrationAdapter(pool),
      logger: getLogger().child({ module: 'migrations:postgres' }),
    });
    await runner.run();
  }

  async save(envelope: UnifiedEnvelope): Promise<void> {
    const pool = this.requirePool();
    const preview = extractPreview(envelope);

    await pool.query(
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
    const pool = this.requirePool();

    const { where, params } = this.buildWhere(filters);
    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;

    const countRes = await pool.query(`SELECT COUNT(*)::int as total FROM messages ${where}`, params);
    const total = countRes.rows[0].total;

    const idx = params.length;
    const rows = await pool.query(
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
    const pool = this.requirePool();
    const res = await pool.query('SELECT * FROM messages WHERE id = $1', [messageId]);
    return res.rows.length > 0 ? this.rowToEnvelope(res.rows[0]) : undefined;
  }

  async count(filters?: Partial<MessageQuery>): Promise<number> {
    const pool = this.requirePool();
    if (!filters || Object.keys(filters).length === 0) {
      const res = await pool.query('SELECT COUNT(*)::int as total FROM messages');
      return res.rows[0].total;
    }
    const { where, params } = this.buildWhere(filters as MessageQuery);
    const res = await pool.query(`SELECT COUNT(*)::int as total FROM messages ${where}`, params);
    return res.rows[0].total;
  }

  async search(query: string, options?: SearchOptions): Promise<MessageQueryResult> {
    const pool = this.requirePool();

    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    let paramIdx = 1;
    let where = `WHERE search_vector @@ plainto_tsquery($${paramIdx})`;
    const params: unknown[] = [query];

    if (options?.accountId) {
      where += ` AND account_id = $${++paramIdx}`;
      params.push(options.accountId);
    }

    const countRes = await pool.query(`SELECT COUNT(*)::int as total FROM messages ${where}`, params);
    const total = countRes.rows[0].total;

    const limitIdx = params.length + 1;
    const rows = await pool.query(
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

  async getStats(options?: StatsOptions): Promise<MessageStats> {
    const pool = this.requirePool();

    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 0;

    if (options?.accountId) { conditions.push(`account_id = $${++idx}`); params.push(options.accountId); }
    if (options?.since) { conditions.push(`timestamp >= $${++idx}`); params.push(toUTC(options.since)); }
    if (options?.until) { conditions.push(`timestamp <= $${++idx}`); params.push(toUTC(options.until)); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const [totalRes, channelRes, typeRes, dirRes, convRes, hourRes] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int as total FROM messages ${where}`, params),
      pool.query(`SELECT channel, COUNT(*)::int as cnt FROM messages ${where} GROUP BY channel`, params),
      pool.query(`SELECT content_type, COUNT(*)::int as cnt FROM messages ${where} GROUP BY content_type`, params),
      pool.query(`SELECT direction, COUNT(*)::int as cnt FROM messages ${where} GROUP BY direction`, params),
      pool.query(
        `SELECT conversation_id, COUNT(*)::int as cnt, MAX(content_preview) as last_preview FROM messages ${where} GROUP BY conversation_id ORDER BY cnt DESC LIMIT 10`,
        params,
      ),
      pool.query(
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

  async getConversationHistory(
    conversationId: string,
    options?: ConversationHistoryOptions,
  ): Promise<RawConversationHistory> {
    const pool = this.requirePool();

    const limit = options?.limit ?? 50;
    const conditions = ['conversation_id = $1'];
    const params: unknown[] = [conversationId];
    let idx = 1;

    if (options?.accountId) { conditions.push(`account_id = $${++idx}`); params.push(options.accountId); }
    if (options?.since) { conditions.push(`timestamp >= $${++idx}`); params.push(toUTC(options.since)); }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const limitIdx = idx + 1;

    const [totalRes, participantRes, rowsRes] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int as total FROM messages ${where}`, params),
      pool.query(
        `SELECT sender_id, sender_name, COUNT(*)::int as cnt FROM messages ${where} GROUP BY sender_id, sender_name ORDER BY cnt DESC`,
        params,
      ),
      pool.query(
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

    // Extract group name from last message's channel details
    const lastRow = rowsRes.rows[rowsRes.rows.length - 1];
    let groupName: string | undefined;
    if (lastRow?.channel_details_json) {
      try {
        groupName = parseJsonColumn<{ groupName?: string }>(lastRow.channel_details_json)?.groupName;
      } catch { /* non-critical */ }
    }

    return {
      conversationId,
      groupName,
      participantCount: participants.length,
      participants,
      totalMessages: totalRes.rows[0].total,
      envelopes,
    };
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  // ── Private helpers ────────────────────────────────────────────

  /** Fail fast if the store was not initialized */
  private requirePool(): PgPool {
    if (!this.pool) {
      throw new Error('PostgresMessageStore not initialized — call init() first');
    }
    return this.pool;
  }

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
