import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type Database from 'better-sqlite3';
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
import { toUTC, MAX_EXPORT_LIMIT, clampPageLimit, cutoffUTC, waMessageIdOf } from '../core/persistence/message-store.utils.js';
import {
  buildMessageWhere, envelopeColumns, MESSAGE_INSERT_COLUMNS, messageRowValues, parseJsonColumn, rowToEnvelope,
  statsFromRows, statsQueries, toJsonColumn, type StatsDialect, type StatsRows,
} from './message-row.js';

const COLUMNS = envelopeColumns('sqlite');

const placeholder = () => '?';

const STATS_DIALECT: StatsDialect = {
  count: 'COUNT(*)',
  hour: "CAST(strftime('%H', timestamp, 'utc') AS INTEGER)",
};

/** What the data itself caused: the same row fails again. A busy or full database is not here, it may pass. */
const REFUSED_DATA_CODE = /^SQLITE_(CONSTRAINT|MISMATCH|TOOBIG)/;

const isRefusedData = (err: unknown): boolean =>
  typeof (err as { code?: unknown }).code === 'string' && REFUSED_DATA_CODE.test((err as { code: string }).code);

/** Rows a retention delete takes at a time. SQLite runs on the event loop: each batch holds up every request and message. */
export const RETENTION_DELETE_BATCH = 1_000;

/** Thrown inside the transaction, so it rolls back the number taken for a message already stored. */
class DuplicateMessage extends Error {
  constructor(readonly result: InsertResult) {
    super('duplicate message');
  }
}

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

  async save(envelope: UnifiedEnvelope, raw?: unknown): Promise<void> {
    const db = this.requireDb();

    db.prepare(`
      INSERT INTO messages (${MESSAGE_INSERT_COLUMNS})
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        content_json = excluded.content_json,
        content_preview = excluded.content_preview,
        context_json = excluded.context_json,
        channel_details_json = excluded.channel_details_json,
        gateway_json = excluded.gateway_json
    `).run(...messageRowValues(envelope, raw));
  }

  async query(filters: MessageQuery): Promise<MessageQueryResult> {
    const db = this.requireDb();

    const { where, params } = buildMessageWhere(filters, placeholder);
    const limit = clampPageLimit(filters.limit ?? 50, MAX_EXPORT_LIMIT);
    const offset = filters.offset ?? 0;

    const countRow = db.prepare(`SELECT COUNT(*) as total FROM messages ${where}`).get(...params) as { total: number };
    const rows = db.prepare(`SELECT ${COLUMNS} FROM messages ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);

    return {
      messages: rows.map((r) => rowToEnvelope(r as Record<string, unknown>)),
      total: countRow.total,
      limit,
      offset,
    };
  }

  async findById(messageId: string): Promise<UnifiedEnvelope | undefined> {
    const db = this.requireDb();
    const row = db.prepare(`SELECT ${COLUMNS} FROM messages WHERE id = ?`).get(messageId);
    return row ? rowToEnvelope(row as Record<string, unknown>) : undefined;
  }

  async count(filters?: Partial<MessageQuery>): Promise<number> {
    const db = this.requireDb();
    if (!filters || Object.keys(filters).length === 0) {
      return (db.prepare('SELECT COUNT(*) as total FROM messages').get() as { total: number }).total;
    }
    const { where, params } = buildMessageWhere(filters, placeholder);
    return (db.prepare(`SELECT COUNT(*) as total FROM messages ${where}`).get(...params) as { total: number }).total;
  }

  async search(query: string, options?: SearchOptions): Promise<MessageQueryResult> {
    const db = this.requireDb();

    const limit = clampPageLimit(options?.limit ?? 50);
    const offset = options?.offset ?? 0;

    let where = 'messages_fts MATCH ?';
    const params: unknown[] = [`"${query.replace(/\0/g, '').replace(/"/g, '""')}"`]; // one literal phrase: the text is data, not FTS5 syntax (which ends at a NUL)

    if (options?.accountId) {
      where += ' AND m.account_id = ?';
      params.push(options.accountId);
    }

    const countRow = db.prepare(
      `SELECT COUNT(*) as total FROM messages_fts f JOIN messages m ON f.id = m.id WHERE ${where}`,
    ).get(...params) as { total: number };

    const rows = db.prepare(
      `SELECT ${envelopeColumns('sqlite', 'm')} FROM messages_fts f JOIN messages m ON f.id = m.id WHERE ${where} ORDER BY rank LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset);

    return {
      messages: rows.map((r) => rowToEnvelope(r as Record<string, unknown>)),
      total: countRow.total,
      limit,
      offset,
    };
  }

  async getStats(options?: StatsOptions): Promise<MessageStats> {
    const db = this.requireDb();

    const { where, params } = buildMessageWhere(options ?? {}, placeholder);
    const sql = statsQueries(where, STATS_DIALECT);
    const all = <Row>(query: string) => db.prepare(query).all(...params) as Row[];

    return statsFromRows({
      total: (db.prepare(sql.total).get(...params) as { total: number }).total,
      channels: all<StatsRows['channels'][number]>(sql.channels),
      types: all<StatsRows['types'][number]>(sql.types),
      directions: all<StatsRows['directions'][number]>(sql.directions),
      conversations: all<StatsRows['conversations'][number]>(sql.conversations),
      hours: all<StatsRows['hours'][number]>(sql.hours),
    });
  }

  async getConversationHistory(
    conversationId: string,
    options?: ConversationHistoryOptions,
  ): Promise<RawConversationHistory> {
    const db = this.requireDb();

    const limit = clampPageLimit(options?.limit ?? 50);
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
      `SELECT * FROM (SELECT ${COLUMNS} FROM messages ${where} ORDER BY timestamp DESC LIMIT ?) ORDER BY timestamp ASC`,
    ).all(...params, limit);

    const envelopes = rows.map((r) => rowToEnvelope(r as Record<string, unknown>));

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

  // ── Message log ────────────────────────────────────────────────

  async ping(): Promise<void> {
    this.requireDb().prepare('SELECT 1').get();
  }

  async insertInbound(envelope: UnifiedEnvelope, raw?: unknown): Promise<InsertResult> {
    const db = this.requireDb();

    // The counter comes first, as in the Postgres store. A duplicate rolls it back.
    const bump = db.prepare(`
      INSERT INTO account_counters (account_id, n) VALUES (?, 1)
      ON CONFLICT (account_id) DO UPDATE SET n = n + 1
      RETURNING n
    `);
    // No conflict target: a retry of the same envelope must be a duplicate even without a WhatsApp id.
    const insert = db.prepare(`
      INSERT INTO messages (${MESSAGE_INSERT_COLUMNS}, account_seq)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING
    `);
    const readSeq = db.prepare('SELECT seq FROM messages WHERE id = ?');
    const readStored = db.prepare(`
      SELECT id, seq, account_seq FROM messages
      WHERE id = @id OR (account_id = @accountId AND wa_message_id = @waMessageId)
      ORDER BY id = @id DESC LIMIT 1
    `);

    const run = db.transaction((): InsertResult => {
      const { n } = bump.get(envelope.accountId) as { n: number };
      const info = insert.run(...messageRowValues(envelope, raw), n);
      if (info.changes === 0) {
        const stored = readStored.get({ id: envelope.id, accountId: envelope.accountId, waMessageId: waMessageIdOf(envelope) }) as
          { id: string; seq: number; account_seq: number } | undefined;
        // With no conflict target this also swallows a number already taken, which is no duplicate: the message would be lost.
        if (!stored) throw new PermanentStoreError(`account_seq ${n} of account ${envelope.accountId} is already taken`);
        throw new DuplicateMessage({ inserted: false, storedId: stored.id, seq: stored.seq, accountSeq: stored.account_seq });
      }

      const { seq } = readSeq.get(envelope.id) as { seq: number };
      return { inserted: true, seq, accountSeq: n };
    });

    try {
      return run();
    } catch (err) {
      if (err instanceof DuplicateMessage) return err.result;
      if (isRefusedData(err)) throw new PermanentStoreError((err as Error).message, { cause: err });
      throw err;
    }
  }

  async queryAfter(q: { accountId: string; afterAccountSeq: number; limit: number }): Promise<{
    messages: UnifiedEnvelope[];
    nextAfterAccountSeq: number | null;
  }> {
    const db = this.requireDb();
    const limit = clampPageLimit(q.limit);

    // Fetch one extra row to know whether another page exists
    const rows = db.prepare(
      `SELECT ${COLUMNS} FROM messages
       WHERE account_id = ? AND account_seq > ?
       ORDER BY account_seq ASC LIMIT ?`,
    ).all(q.accountId, q.afterAccountSeq, limit + 1) as Array<Record<string, unknown>>;

    const hasMore = rows.length > limit;
    const messages = rows.slice(0, limit).map((r) => rowToEnvelope(r));
    const last = messages[messages.length - 1];
    return { messages, nextAfterAccountSeq: hasMore && last?.accountSeq != null ? last.accountSeq : null };
  }

  async findByWaMessageId(accountId: string, waMessageId: string): Promise<StoredEnvelope | undefined> {
    const db = this.requireDb();
    const row = db.prepare(
      `SELECT ${COLUMNS}, raw_json FROM messages WHERE account_id = ? AND wa_message_id = ?`,
    ).get(accountId, waMessageId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const raw = parseJsonColumn(row.raw_json as string | null);
    return raw === undefined ? rowToEnvelope(row) : { ...rowToEnvelope(row), raw };
  }

  async updateMedia(id: string, media: Partial<MediaInfo>): Promise<void> {
    const db = this.requireDb();
    db.prepare(
      `UPDATE messages
       SET content_json = json_set(content_json, '$.media', json(json_patch(COALESCE(json_extract(content_json, '$.media'), '{}'), ?)))
       WHERE id = ?`,
    ).run(toJsonColumn(media), id);
  }

  async findPendingMedia(limit: number, afterSeq = 0): Promise<Array<{ seq: number; id: string; accountId: string; raw: unknown }>> {
    const db = this.requireDb();
    const rows = db.prepare(
      `SELECT seq, id, account_id, raw_json FROM messages
       WHERE json_extract(content_json, '$.media.status') = 'pending' AND raw_json IS NOT NULL AND seq > ?
       ORDER BY seq ASC LIMIT ?`,
    ).all(afterSeq, limit) as Array<{ seq: number; id: string; account_id: string; raw_json: string }>;
    return rows.map((r) => ({ seq: r.seq, id: r.id, accountId: r.account_id, raw: parseJsonColumn(r.raw_json) }));
  }

  async deleteOlderThan(days: number): Promise<number> {
    const cutoff = cutoffUTC(days);
    let deleted = 0;
    for (;;) {
      const { changes } = this.requireDb().prepare(
        'DELETE FROM messages WHERE rowid IN (SELECT rowid FROM messages WHERE created_at < ? LIMIT ?)',
      ).run(cutoff, RETENTION_DELETE_BATCH);
      deleted += changes;
      if (changes < RETENTION_DELETE_BATCH) return deleted;
      await new Promise((resolve) => { setImmediate(resolve); });
    }
  }

  async maxAccountSeq(accountId: string): Promise<number> {
    const db = this.requireDb();
    const row = db.prepare('SELECT n FROM account_counters WHERE account_id = ?').get(accountId) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  async minAccountSeq(accountId: string): Promise<number | null> {
    const db = this.requireDb();
    const row = db.prepare('SELECT MIN(account_seq) AS first FROM messages WHERE account_id = ?').get(accountId) as { first: number | null };
    return row.first;
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
}
