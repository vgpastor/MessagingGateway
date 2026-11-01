import { PermanentStoreError } from '../core/errors.js';
import { getLogger } from '../core/logger/logger.port.js';
import type { UnifiedEnvelope } from '../core/messaging/unified-envelope.js';
import type {
  FullMessageStorePort,
  InsertResult,
  StoredEnvelope,
  MessageQuery,
  MessageQueryResult,
  MessageStats,
  SearchOptions,
  StatsOptions,
  ConversationHistoryOptions,
  RawConversationHistory,
} from '../core/persistence/message-store.port.js';
import type { MediaInfo } from '../core/messaging/content.js';
import {
  toUTC, parseJsonColumnRequired, parseJsonColumn,
  MAX_EXPORT_LIMIT, clampPageLimit, cutoffUTC, envelopeColumns, readLogFields, readSender,
  MESSAGE_INSERT_COLUMNS, messageRowValues, toJsonColumn, waMessageIdOf,
} from '../core/persistence/message-store.utils.js';

type PgPool = import('pg').Pool;
type PoolConfig = import('pg').PoolConfig;

const COLUMNS = envelopeColumns('postgres');

/** How long to wait for a connection before failing the write: its caller has a retry policy. */
const CONNECTION_TIMEOUT_MS = 5_000;

/**
 * How long a statement may take. A connection lost to a network partition never answers, and
 * inserts run inside the account's queue: without this limit one hung insert blocks it for ever.
 */
const QUERY_TIMEOUT_MS = 30_000;

/**
 * How long a transaction may sit open with nothing running. The query timeout only frees the client: a partition
 * leaves the server holding the transaction, and with it the account's counter row, which every insert of that
 * account needs. Postgres ends the session after this. Only {@link insertInbound} opens transactions, in milliseconds.
 */
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;

/** A retention delete can be large, and it holds back no queue. `0` would not disable the limit: pg falls back to the pool's. */
const RETENTION_QUERY_TIMEOUT_MS = 15 * 60 * 1000;

/** SQLSTATE classes of what the data itself caused (22 data exception, 23 integrity violation): the same row fails again. */
const REFUSED_DATA_SQLSTATE = /^2[23]/;

const isRefusedData = (err: unknown): boolean =>
  typeof (err as { code?: unknown }).code === 'string' && REFUSED_DATA_SQLSTATE.test((err as { code: string }).code);

export interface PostgresMessageStoreOptions {
  /** {@link QUERY_TIMEOUT_MS} by default. */
  queryTimeoutMs?: number;
  /** {@link IDLE_IN_TRANSACTION_TIMEOUT_MS} by default. */
  idleInTransactionTimeoutMs?: number;
}

/**
 * PostgreSQL-based message store using the `pg` driver.
 * Lazy-loads `pg` so it's only required when STORAGE_DRIVER=postgres.
 */
export class PostgresMessageStore implements FullMessageStorePort {
  private pool: PgPool | null = null;
  private readonly connectionString: string;

  constructor(connectionString: string, private readonly options: PostgresMessageStoreOptions = {}) {
    this.connectionString = connectionString;
  }

  async init(): Promise<void> {
    try {
      this.pool = await this.createPool({
        query_timeout: this.options.queryTimeoutMs ?? QUERY_TIMEOUT_MS,
        idle_in_transaction_session_timeout: this.options.idleInTransactionTimeoutMs ?? IDLE_IN_TRANSACTION_TIMEOUT_MS,
      });

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

  private async createPool(limits: Pick<PoolConfig, 'query_timeout' | 'idle_in_transaction_session_timeout'> = {}): Promise<PgPool> {
    const { Pool } = await import('pg');
    const pool = new Pool({
      connectionString: this.connectionString,
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
      ...limits,
    });
    // An idle connection dying (Postgres restart) is not fatal: the pool opens another one.
    // Without a listener the 'error' event would take the whole process down.
    pool.on('error', (err) => {
      getLogger().warn('PostgreSQL idle connection lost', { error: err.message });
    });
    return pool;
  }

  /**
   * Run migrations — called externally by the factory after init(). On a pool of their own, with no
   * limits: a migration may rewrite a whole table, and failing it would stop the gateway from starting.
   */
  async runMigrations(): Promise<void> {
    this.requirePool();
    const pool = await this.createPool();
    const { MigrationRunner } = await import('./migrations/migration-runner.js');
    const { PostgresMigrationAdapter } = await import('./migrations/adapters/postgres-migration.adapter.js');
    const { resolveMigrationScriptsDir } = await import('./migrations/resolve-scripts-dir.js');
    const runner = new MigrationRunner({
      scriptsDir: resolveMigrationScriptsDir('postgres'),
      adapter: new PostgresMigrationAdapter(pool),
      logger: getLogger().child({ module: 'migrations:postgres' }),
    });
    try {
      await runner.run();
    } finally {
      await pool.end();
    }
  }

  async save(envelope: UnifiedEnvelope, raw?: unknown): Promise<void> {
    const pool = this.requirePool();

    await pool.query(
      `INSERT INTO messages (${MESSAGE_INSERT_COLUMNS})
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      ON CONFLICT (id) DO UPDATE SET
        content_json = EXCLUDED.content_json,
        content_preview = EXCLUDED.content_preview,
        context_json = EXCLUDED.context_json,
        channel_details_json = EXCLUDED.channel_details_json,
        gateway_json = EXCLUDED.gateway_json`,
      messageRowValues(envelope, raw),
    );
  }

  async query(filters: MessageQuery): Promise<MessageQueryResult> {
    const pool = this.requirePool();

    const { where, params } = this.buildWhere(filters);
    const limit = clampPageLimit(filters.limit ?? 50, MAX_EXPORT_LIMIT);
    const offset = filters.offset ?? 0;

    const countRes = await pool.query(`SELECT COUNT(*)::int as total FROM messages ${where}`, params);
    const total = countRes.rows[0].total;

    const idx = params.length;
    const rows = await pool.query(
      `SELECT ${COLUMNS} FROM messages ${where} ORDER BY timestamp DESC LIMIT $${idx + 1} OFFSET $${idx + 2}`,
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
    const res = await pool.query(`SELECT ${COLUMNS} FROM messages WHERE id = $1`, [messageId]);
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

    const limit = clampPageLimit(options?.limit ?? 50);
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
      `SELECT ${COLUMNS}, ts_rank(search_vector, plainto_tsquery($1)) as rank FROM messages ${where} ORDER BY rank DESC LIMIT $${limitIdx} OFFSET $${limitIdx + 1}`,
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

    const limit = clampPageLimit(options?.limit ?? 50);
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
        `SELECT * FROM (SELECT ${COLUMNS} FROM messages ${where} ORDER BY timestamp DESC LIMIT $${limitIdx}) sub ORDER BY timestamp ASC`,
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

  // ── Message log ────────────────────────────────────────────────

  async insertInbound(envelope: UnifiedEnvelope, raw?: unknown): Promise<InsertResult> {
    const pool = this.requirePool();
    const client = await pool.connect();
    // The pool only listens on idle clients: a checked-out one losing its connection would crash the process.
    // The running query rejects anyway, so there is nothing else to do here.
    const onConnectionError = () => {};
    client.on('error', onConnectionError);
    let failure: Error | undefined;
    try {
      await client.query('BEGIN');

      // The counter comes first: its row lock serializes concurrent inserts of the same account until COMMIT,
      // so account_seq is handed out contiguously and becomes visible in order. A duplicate rolls it back.
      const counter = await client.query(
        `INSERT INTO account_counters (account_id, n) VALUES ($1, 1)
         ON CONFLICT (account_id) DO UPDATE SET n = account_counters.n + 1
         RETURNING n`,
        [envelope.accountId],
      );
      const accountSeq = Number(counter.rows[0].n);

      // No conflict target: a retry of the same envelope must be a duplicate even without a WhatsApp id.
      const inserted = await client.query(
        `INSERT INTO messages (${MESSAGE_INSERT_COLUMNS}, account_seq)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
        ON CONFLICT DO NOTHING
        RETURNING seq`,
        [...messageRowValues(envelope, raw), accountSeq],
      );

      if (inserted.rowCount === 0) {
        const stored = await client.query(
          `SELECT id, seq, account_seq FROM messages
           WHERE id = $1 OR (account_id = $2 AND wa_message_id = $3)
           ORDER BY id = $1 DESC LIMIT 1`,
          [envelope.id, envelope.accountId, waMessageIdOf(envelope)],
        );
        await client.query('ROLLBACK');
        const row = stored.rows[0];
        // With no conflict target this also swallows a number already taken, which is no duplicate: the message would be lost.
        if (!row) throw new PermanentStoreError(`account_seq ${accountSeq} of account ${envelope.accountId} is already taken`);
        return { inserted: false, storedId: row.id, seq: Number(row.seq), accountSeq: Number(row.account_seq) };
      }

      await client.query('COMMIT');
      return { inserted: true, seq: Number(inserted.rows[0].seq), accountSeq };
    } catch (err) {
      failure = err instanceof Error ? err : new Error(String(err));
      throw isRefusedData(err) ? new PermanentStoreError(failure.message, { cause: err }) : err;
    } finally {
      client.removeListener('error', onConnectionError);
      // A failure discards the connection, and Postgres rolls back when it closes. A ROLLBACK would queue behind
      // a hung statement, take its own timeout, and return a connection with the transaction open to the pool.
      client.release(failure);
    }
  }

  async queryAfter(q: { accountId: string; afterAccountSeq: number; limit: number }): Promise<{
    messages: UnifiedEnvelope[];
    nextAfterAccountSeq: number | null;
  }> {
    const pool = this.requirePool();
    const limit = clampPageLimit(q.limit);

    // Fetch one extra row to know whether another page exists
    const res = await pool.query(
      `SELECT ${COLUMNS} FROM messages
       WHERE account_id = $1 AND account_seq > $2
       ORDER BY account_seq ASC LIMIT $3`,
      [q.accountId, q.afterAccountSeq, limit + 1],
    );

    const hasMore = res.rows.length > limit;
    const messages = res.rows.slice(0, limit).map((r) => this.rowToEnvelope(r));
    const last = messages[messages.length - 1];
    return { messages, nextAfterAccountSeq: hasMore && last?.accountSeq != null ? last.accountSeq : null };
  }

  async findByWaMessageId(accountId: string, waMessageId: string): Promise<StoredEnvelope | undefined> {
    const pool = this.requirePool();
    const res = await pool.query(
      `SELECT ${COLUMNS}, raw_json FROM messages WHERE account_id = $1 AND wa_message_id = $2`,
      [accountId, waMessageId],
    );
    const row = res.rows[0];
    if (!row) return undefined;
    const raw = parseJsonColumn(row.raw_json as string | null);
    return raw === undefined ? this.rowToEnvelope(row) : { ...this.rowToEnvelope(row), raw };
  }

  async updateMedia(id: string, media: Partial<MediaInfo>): Promise<void> {
    const pool = this.requirePool();
    await pool.query(
      `UPDATE messages
       SET content_json = jsonb_set(content_json, '{media}', COALESCE(content_json->'media', '{}'::jsonb) || $2::jsonb)
       WHERE id = $1`,
      [id, toJsonColumn(media)],
    );
  }

  async findPendingMedia(limit: number): Promise<Array<{ id: string; accountId: string; raw: unknown }>> {
    const pool = this.requirePool();
    const res = await pool.query(
      `SELECT id, account_id, raw_json FROM messages
       WHERE (content_json->'media'->>'status') = 'pending' AND raw_json IS NOT NULL
       ORDER BY seq ASC LIMIT $1`,
      [limit],
    );
    return res.rows.map((r) => ({ id: r.id, accountId: r.account_id, raw: parseJsonColumn(r.raw_json) }));
  }

  async deleteOlderThan(days: number): Promise<number> {
    const pool = this.requirePool();
    const res = await pool.query({
      text: 'DELETE FROM messages WHERE created_at < $1',
      values: [cutoffUTC(days)],
      query_timeout: RETENTION_QUERY_TIMEOUT_MS,
    } as import('pg').QueryConfig);
    return res.rowCount ?? 0;
  }

  async maxAccountSeq(accountId: string): Promise<number> {
    const pool = this.requirePool();
    const res = await pool.query('SELECT n FROM account_counters WHERE account_id = $1', [accountId]);
    return res.rows.length > 0 ? Number(res.rows[0].n) : 0;
  }

  async minAccountSeq(accountId: string): Promise<number | null> {
    const pool = this.requirePool();
    const res = await pool.query('SELECT MIN(account_seq) AS first FROM messages WHERE account_id = $1', [accountId]);
    const first = res.rows[0].first as string | null;
    return first === null ? null : Number(first);
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
      sender: readSender(row),
      recipient: { id: row.recipient_id as string },
      content: parseJsonColumnRequired(row.content_json as string),
      context: parseJsonColumn(row.context_json as string | null) ?? undefined,
      channelDetails: parseJsonColumn(row.channel_details_json as string | null) ?? undefined,
      gateway: parseJsonColumnRequired(row.gateway_json as string),
      ...readLogFields(row),
    } as UnifiedEnvelope;
  }
}
