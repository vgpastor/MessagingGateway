/**
 * Message-log migration over data that already exists (the production path:
 * ~225k rows written under the 001 schema before the log columns existed).
 *
 * Both drivers: build the 001 schema, seed legacy rows (duplicate WhatsApp ids,
 * empty ids, two accounts, interleaved insertion order), run the new migration
 * and check the invariants the message log relies on.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MigrationRunner } from '../../../src/persistence/migrations/migration-runner.js';
import { PostgresMigrationAdapter } from '../../../src/persistence/migrations/adapters/postgres-migration.adapter.js';
import { SqliteMigrationAdapter } from '../../../src/persistence/migrations/adapters/sqlite-migration.adapter.js';
import { resolveMigrationScriptsDir } from '../../../src/persistence/migrations/resolve-scripts-dir.js';
import { PostgresMessageStore } from '../../../src/persistence/postgres-message-store.js';
import { SqliteMessageStore } from '../../../src/persistence/sqlite-message-store.js';
import type { UnifiedEnvelope } from '../../../src/core/messaging/unified-envelope.js';
import { testDatabaseUrl } from '../../helpers/test-database-url.js';

const silent = { info: () => {}, error: () => {} };

/**
 * Legacy rows in INSERTION order. `wa` is the value of channel_details_json.messageId
 * (`undefined` = no channel details at all, '' = empty id).
 */
const LEGACY: Array<{ id: string; account: string; wa: string | undefined }> = [
  { id: 'm1', account: 'acc-a', wa: 'W1' },
  { id: 'm7', account: 'acc-b', wa: 'W1' }, // same WA id, other account: NOT a duplicate
  { id: 'm2', account: 'acc-a', wa: '' },
  { id: 'm3', account: 'acc-a', wa: 'W1' }, // duplicate of m1 -> removed
  { id: 'm4', account: 'acc-a', wa: 'W2' },
  { id: 'm8', account: 'acc-b', wa: 'W9' },
  { id: 'm5', account: 'acc-a', wa: undefined },
  { id: 'm9', account: 'acc-b', wa: 'W9' }, // duplicate of m8 -> removed
  { id: 'm6', account: 'acc-a', wa: '' },
  { id: 'm10', account: 'acc-a', wa: 'W2' }, // second duplicate of m4 -> removed
];

const EXPECTED = {
  'acc-a': ['m1', 'm2', 'm4', 'm5', 'm6'],
  'acc-b': ['m7', 'm8'],
} as const;

function legacyColumns(row: (typeof LEGACY)[number]) {
  const details = row.wa === undefined ? null : JSON.stringify({ platform: 'whatsapp', messageId: row.wa });
  return [
    row.id, row.account, 'whatsapp', 'inbound', 'conv-1', 'sender-1', 'Sender', 'recipient-1',
    'text', `preview ${row.id}`, JSON.stringify({ type: 'text', body: row.id }), null, details,
    JSON.stringify({ adapterId: 'baileys' }), '2026-04-05T10:00:00.000Z', '2026-04-05T10:00:00.000Z',
  ];
}

async function copyInitialMigration(driver: 'postgres' | 'sqlite'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `mg-legacy-${driver}-`));
  const target = join(dir, driver);
  await mkdir(target);
  const source = resolveMigrationScriptsDir(driver);
  await copyFile(join(source, '001_initial_schema.sql'), join(target, '001_initial_schema.sql'));
  if (driver === 'sqlite') {
    await copyFile(join(source, '002_fts_delete_trigger.sql'), join(target, '002_fts_delete_trigger.sql'));
  }
  return dir;
}

function makeEnvelope(accountId: string, wa: string): UnifiedEnvelope {
  const now = new Date('2026-05-01T10:00:00Z');
  return {
    id: `msg_${randomUUID()}`,
    accountId,
    channel: 'whatsapp',
    direction: 'inbound',
    timestamp: now,
    sentAt: now,
    conversationId: 'conv-1',
    sender: { id: 'sender-1' },
    recipient: { id: 'recipient-1' },
    content: { type: 'text', body: 'after migration' },
    channelDetails: { platform: 'whatsapp', messageId: wa },
    gateway: { receivedAt: now, adapterId: 'baileys', account: { id: accountId, alias: accountId, owner: 'o', tags: [] } },
  };
}

// ── PostgreSQL ────────────────────────────────────────────────────

const PG_URL = testDatabaseUrl();

describe.skipIf(!PG_URL)('message-log migration 002 on existing data (postgres)', () => {
  let admin: import('pg').Pool;
  let schema: string;
  let legacyDir: string;
  let store: PostgresMessageStore;

  const q = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows;

  beforeEach(async () => {
    const { Pool } = await import('pg');
    schema = `mlogmig_${randomUUID().replace(/-/g, '')}`;
    const url = new URL(PG_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);

    admin = new Pool({ connectionString: url.toString() });
    await new (await import('pg')).Pool({ connectionString: PG_URL }).query(`CREATE SCHEMA "${schema}"`);

    // 1. Build the schema exactly as production has it today (001 only)
    legacyDir = await copyInitialMigration('postgres');
    await new MigrationRunner({
      scriptsDir: join(legacyDir, 'postgres'),
      adapter: new PostgresMigrationAdapter(admin),
      logger: silent,
    }).run();

    // 2. Seed legacy rows in insertion order
    for (const row of LEGACY) {
      await admin.query(
        `INSERT INTO messages (id, account_id, channel, direction, conversation_id, sender_id, sender_name,
           recipient_id, content_type, content_preview, content_json, context_json, channel_details_json,
           gateway_json, timestamp, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        legacyColumns(row),
      );
    }

    // 3. Boot the real store: only 002 is pending
    store = new PostgresMessageStore(url.toString());
    await store.init();
    await store.runMigrations();
  });

  afterEach(async () => {
    await store.close();
    await admin.end();
    const { Pool } = await import('pg');
    const cleanup = new Pool({ connectionString: PG_URL });
    await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await cleanup.end();
    await rm(legacyDir, { recursive: true, force: true });
  });

  it('removes duplicate WhatsApp ids keeping the oldest row by created_at, then seq', async () => {
    const ids = (await q('SELECT id FROM messages ORDER BY seq')).map((r) => r.id);
    expect(ids).toEqual(['m1', 'm7', 'm2', 'm4', 'm8', 'm5', 'm6']);
  });

  it('numbers account_seq 1..n per account following the original insertion order', async () => {
    for (const [account, expected] of Object.entries(EXPECTED)) {
      const rows = await q('SELECT id, account_seq FROM messages WHERE account_id = $1 ORDER BY account_seq', [account]);
      expect(rows.map((r) => r.id)).toEqual(expected);
      expect(rows.map((r) => Number(r.account_seq))).toEqual(expected.map((_, i) => i + 1));
    }
  });

  it('seeds account_counters with the max account_seq per account', async () => {
    const rows = await q('SELECT account_id, n FROM account_counters ORDER BY account_id');
    expect(rows.map((r) => [r.account_id, Number(r.n)])).toEqual([['acc-a', 5], ['acc-b', 2]]);
  });

  it('turns empty or missing messageId into NULL wa_message_id', async () => {
    const rows = await q('SELECT id, wa_message_id FROM messages ORDER BY seq');
    expect(Object.fromEntries(rows.map((r) => [r.id, r.wa_message_id]))).toEqual({
      m1: 'W1', m7: 'W1', m2: null, m4: 'W2', m8: 'W9', m5: null, m6: null,
    });
  });

  it('creates the unique indexes and drops the content_json GIN index', async () => {
    const idx = (await q(`SELECT indexname FROM pg_indexes WHERE schemaname = $1`, [schema])).map((r) => r.indexname);
    expect(idx).toEqual(expect.arrayContaining(['uq_messages_account_wa', 'uq_messages_account_seq', 'uq_messages_seq']));
    expect(idx).not.toContain('idx_messages_content_json');

    const dupAfter = await q(
      `INSERT INTO messages (id, account_id, channel, direction, conversation_id, sender_id, recipient_id, content_type, content_json, gateway_json, timestamp, wa_message_id)
       VALUES ('x1','acc-a','whatsapp','inbound','c','s','r','text','{}','{}',NOW(),'W1') ON CONFLICT DO NOTHING RETURNING id`,
    );
    expect(dupAfter).toEqual([]);
  });

  it('keeps legacy rows readable and continues the sequence for new inbound messages', async () => {
    const legacy = await store.findById('m4');
    expect(legacy?.accountSeq).toBe(3);
    expect(legacy?.seq).toBeGreaterThan(0);
    expect(legacy?.sentAt).toBeUndefined();

    const dup = await store.insertInbound(makeEnvelope('acc-a', 'W2'));
    expect(dup).toMatchObject({ inserted: false });

    const fresh = await store.insertInbound(makeEnvelope('acc-a', 'W3'));
    expect(fresh.accountSeq).toBe(6);
    expect(await store.maxAccountSeq('acc-a')).toBe(6);
    expect(await store.maxAccountSeq('acc-b')).toBe(2);

    const lastLegacySeq = Number((await q('SELECT MAX(seq) AS m FROM messages WHERE id <> $1', [(await store.findByWaMessageId('acc-a', 'W3'))!.id]))[0].m);
    expect(fresh.seq).toBeGreaterThan(lastLegacySeq);
  });

  it('is applied only once (re-running migrations is a no-op)', async () => {
    await store.runMigrations();
    expect(await q('SELECT COUNT(*)::int AS c FROM messages')).toEqual([{ c: 7 }]);
  });
});

describe.skipIf(!PG_URL)('message-log migration 002: the indexes during the rewrite (postgres)', () => {
  const OLD_INDEXES = [
    'idx_messages_account', 'idx_messages_conversation', 'idx_messages_direction', 'idx_messages_search',
    'idx_messages_sender', 'idx_messages_timestamp', 'idx_messages_type',
  ];
  let root: import('pg').Pool;
  let admin: import('pg').Pool;
  let schema: string;
  let legacyDir: string;
  let store: PostgresMessageStore;

  const indexes = async () => (await admin.query(
    `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'messages' ORDER BY indexname`, [schema],
  )).rows.map((r) => r.indexname as string);

  beforeEach(async () => {
    const { Pool } = await import('pg');
    schema = `mlogidx_${randomUUID().replace(/-/g, '')}`;
    root = new Pool({ connectionString: PG_URL });
    await root.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(PG_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    admin = new Pool({ connectionString: url.toString() });

    legacyDir = await copyInitialMigration('postgres');
    await new MigrationRunner({ scriptsDir: join(legacyDir, 'postgres'), adapter: new PostgresMigrationAdapter(admin), logger: silent }).run();
    for (const row of LEGACY) {
      await admin.query(
        `INSERT INTO messages (id, account_id, channel, direction, conversation_id, sender_id, sender_name,
           recipient_id, content_type, content_preview, content_json, context_json, channel_details_json,
           gateway_json, timestamp, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        legacyColumns(row),
      );
    }
    store = new PostgresMessageStore(url.toString());
    await store.init();
  });

  afterEach(async () => {
    await store.close();
    await admin.end();
    await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await root.end();
    await rm(legacyDir, { recursive: true, force: true });
  });

  it('leaves only the primary key on the table while it deletes and rewrites rows, and puts the rest back at the end', async () => {
    await admin.query(`
      CREATE TABLE index_probe (operation TEXT, names TEXT);
      CREATE FUNCTION probe_indexes() RETURNS trigger AS $fn$
      BEGIN
        INSERT INTO index_probe
          SELECT TG_OP, string_agg(indexname, ',' ORDER BY indexname)
          FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'messages';
        RETURN NULL;
      END $fn$ LANGUAGE plpgsql;
      CREATE TRIGGER probe_delete BEFORE DELETE ON messages FOR EACH STATEMENT EXECUTE FUNCTION probe_indexes();
      CREATE TRIGGER probe_update BEFORE UPDATE ON messages FOR EACH STATEMENT EXECUTE FUNCTION probe_indexes();
    `);

    await store.runMigrations();

    const probed = (await admin.query('SELECT operation, names FROM index_probe ORDER BY operation')).rows;
    expect(probed).toEqual([
      { operation: 'DELETE', names: 'messages_pkey' },
      { operation: 'UPDATE', names: 'messages_pkey' },
    ]);
    const after = await indexes();
    expect(after).toEqual(expect.arrayContaining([...OLD_INDEXES, 'messages_pkey', 'uq_messages_account_wa', 'uq_messages_account_seq', 'uq_messages_seq']));
    expect(after).not.toContain('idx_messages_content_json');
  });

  it('search still works on the recreated full-text index', async () => {
    await store.runMigrations();

    expect((await store.search('m4')).messages.map((m) => m.id)).toEqual(['m4']);
  });

  it('a failure half way leaves every old index in place and nothing recorded', async () => {
    const before = await indexes();
    expect(before).toEqual(expect.arrayContaining([...OLD_INDEXES, 'idx_messages_content_json']));
    await admin.query('CREATE TABLE account_counters (taken BOOLEAN)'); // 002 creates it after the rewrite

    await expect(store.runMigrations()).rejects.toThrow(/account_counters/);

    expect(await indexes()).toEqual(before);
    const recorded = (await admin.query('SELECT name FROM _migrations ORDER BY name')).rows.map((r) => r.name);
    expect(recorded).toEqual(['001_initial_schema']);
    const columns = (await admin.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'messages' AND column_name = 'account_seq'`, [schema])).rows;
    expect(columns).toEqual([]);
  });
});

// ── SQLite ────────────────────────────────────────────────────────

describe('message-log migration 003 on existing data (sqlite)', () => {
  let legacyDir: string;
  let store: SqliteMessageStore;
  let db: import('better-sqlite3').Database;

  beforeEach(async () => {
    const Database = (await import('better-sqlite3')).default;
    db = new Database(':memory:');

    legacyDir = await copyInitialMigration('sqlite');
    await new MigrationRunner({
      scriptsDir: join(legacyDir, 'sqlite'),
      adapter: new SqliteMigrationAdapter(db),
      logger: silent,
    }).run();

    const insert = db.prepare(
      `INSERT INTO messages (id, account_id, channel, direction, conversation_id, sender_id, sender_name,
         recipient_id, content_type, content_preview, content_json, context_json, channel_details_json,
         gateway_json, timestamp, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const row of LEGACY) insert.run(...legacyColumns(row));

    // Hand the already-legacy database to the real store, then run the pending migration
    store = new SqliteMessageStore(':memory:');
    (store as unknown as { db: unknown }).db = db;
    await store.runMigrations();
  });

  afterEach(async () => {
    await store.close();
    await rm(legacyDir, { recursive: true, force: true });
  });

  it('dedupes, numbers account_seq per account, seeds counters and nulls empty ids', () => {
    const rows = db.prepare('SELECT id, account_id, account_seq, wa_message_id, seq FROM messages ORDER BY seq').all() as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.id)).toEqual(['m1', 'm7', 'm2', 'm4', 'm8', 'm5', 'm6']);
    for (const [account, expected] of Object.entries(EXPECTED)) {
      const mine = rows.filter((r) => r.account_id === account).sort((a, b) => (a.account_seq as number) - (b.account_seq as number));
      expect(mine.map((r) => r.id)).toEqual(expected);
      expect(mine.map((r) => r.account_seq)).toEqual(expected.map((_, i) => i + 1));
    }
    expect(Object.fromEntries(rows.map((r) => [r.id, r.wa_message_id]))).toEqual({
      m1: 'W1', m7: 'W1', m2: null, m4: 'W2', m8: 'W9', m5: null, m6: null,
    });
    expect(db.prepare('SELECT account_id, n FROM account_counters ORDER BY account_id').all()).toEqual([
      { account_id: 'acc-a', n: 5 }, { account_id: 'acc-b', n: 2 },
    ]);
  });

  it('continues the sequence and dedupes for new inbound messages', async () => {
    expect(await store.insertInbound(makeEnvelope('acc-a', 'W2'))).toMatchObject({ inserted: false });
    const fresh = await store.insertInbound(makeEnvelope('acc-a', 'W3'));
    expect(fresh.accountSeq).toBe(6);
    expect(await store.maxAccountSeq('acc-b')).toBe(2);
  });
});

// ── Which duplicate survives, and account_seq order by created_at ──
//
// Baileys upserts an empty CIPHERTEXT stub (stored as `{type:'text', body:''}`) when it
// cannot decrypt a message and the real message arrives later with the same WhatsApp id.
// The migration must keep the row that has the content, and number account_seq by
// `created_at` (then seq), not by heap order alone.

/** Rows in INSERTION (heap) order, deliberately out of created_at order. */
const RANKED: Array<{ id: string; wa: string | undefined; body: string; createdAt: string }> = [
  { id: 'x4', wa: 'D2', body: 'later duplicate', createdAt: '2026-04-05T10:05:00.000Z' },
  { id: 'x1', wa: 'D1', body: '', createdAt: '2026-04-05T10:01:00.000Z' }, // empty stub, OLDER -> removed
  { id: 'x2', wa: 'D1', body: 'real content', createdAt: '2026-04-05T10:02:00.000Z' }, // content -> kept
  { id: 'x5', wa: 'D2', body: 'earlier duplicate', createdAt: '2026-04-05T10:04:00.000Z' }, // older by created_at -> kept
  { id: 'x3', wa: undefined, body: 'oldest', createdAt: '2026-04-05T10:00:00.000Z' }, // inserted last, oldest
];
const RANKED_EXPECTED = ['x3', 'x2', 'x5'];

function rankedColumns(row: (typeof RANKED)[number]) {
  const details = row.wa === undefined ? null : JSON.stringify({ platform: 'whatsapp', messageId: row.wa });
  return [
    row.id, 'acc-c', 'whatsapp', 'inbound', 'conv-1', 'sender-1', 'Sender', 'recipient-1',
    'text', row.body, JSON.stringify({ type: 'text', body: row.body }), null, details,
    JSON.stringify({ adapterId: 'baileys' }), row.createdAt, row.createdAt,
  ];
}

describe.skipIf(!PG_URL)('message-log migration 002 dedupe ranking (postgres)', () => {
  let admin: import('pg').Pool;
  let schema: string;
  let legacyDir: string;
  let store: PostgresMessageStore;

  beforeEach(async () => {
    const { Pool } = await import('pg');
    schema = `mlogrank_${randomUUID().replace(/-/g, '')}`;
    const url = new URL(PG_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    const root = new Pool({ connectionString: PG_URL });
    await root.query(`CREATE SCHEMA "${schema}"`);
    await root.end();
    admin = new Pool({ connectionString: url.toString() });

    legacyDir = await copyInitialMigration('postgres');
    await new MigrationRunner({ scriptsDir: join(legacyDir, 'postgres'), adapter: new PostgresMigrationAdapter(admin), logger: silent }).run();
    for (const row of RANKED) {
      await admin.query(
        `INSERT INTO messages (id, account_id, channel, direction, conversation_id, sender_id, sender_name,
           recipient_id, content_type, content_preview, content_json, context_json, channel_details_json,
           gateway_json, timestamp, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        rankedColumns(row),
      );
    }
    store = new PostgresMessageStore(url.toString());
    await store.init();
    await store.runMigrations();
  });

  afterEach(async () => {
    await store.close();
    await admin.end();
    const { Pool } = await import('pg');
    const cleanup = new Pool({ connectionString: PG_URL });
    await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await cleanup.end();
    await rm(legacyDir, { recursive: true, force: true });
  });

  it('keeps the row with content over an older empty-text stub of the same WhatsApp id', async () => {
    const d1 = (await admin.query(`SELECT id, content_json FROM messages WHERE wa_message_id = 'D1'`)).rows;
    expect(d1).toEqual([{ id: 'x2', content_json: { type: 'text', body: 'real content' } }]);
  });

  it('between two rows with content keeps the oldest by created_at, not the lowest seq', async () => {
    const d2 = (await admin.query(`SELECT id FROM messages WHERE wa_message_id = 'D2'`)).rows.map((r) => r.id);
    expect(d2).toEqual(['x5']);
  });

  it('numbers account_seq by created_at when heap order differs', async () => {
    const rows = (await admin.query(`SELECT id, account_seq FROM messages ORDER BY account_seq`)).rows;
    expect(rows.map((r) => r.id)).toEqual(RANKED_EXPECTED);
    expect(rows.map((r) => Number(r.account_seq))).toEqual([1, 2, 3]);
    expect((await admin.query(`SELECT n FROM account_counters WHERE account_id = 'acc-c'`)).rows.map((r) => Number(r.n))).toEqual([3]);
  });
});

describe('message-log migration 003 dedupe ranking (sqlite)', () => {
  let legacyDir: string;
  let store: SqliteMessageStore;
  let db: import('better-sqlite3').Database;

  beforeEach(async () => {
    const Database = (await import('better-sqlite3')).default;
    db = new Database(':memory:');
    legacyDir = await copyInitialMigration('sqlite');
    await new MigrationRunner({ scriptsDir: join(legacyDir, 'sqlite'), adapter: new SqliteMigrationAdapter(db), logger: silent }).run();
    const insert = db.prepare(
      `INSERT INTO messages (id, account_id, channel, direction, conversation_id, sender_id, sender_name,
         recipient_id, content_type, content_preview, content_json, context_json, channel_details_json,
         gateway_json, timestamp, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const row of RANKED) insert.run(...rankedColumns(row));
    store = new SqliteMessageStore(':memory:');
    (store as unknown as { db: unknown }).db = db;
    await store.runMigrations();
  });

  afterEach(async () => {
    await store.close();
    await rm(legacyDir, { recursive: true, force: true });
  });

  it('keeps the content row over an older empty-text stub, the oldest by created_at otherwise', () => {
    const byWa = db.prepare(`SELECT wa_message_id AS wa, id, content_json FROM messages WHERE wa_message_id IS NOT NULL ORDER BY wa_message_id`).all();
    expect(byWa).toEqual([
      { wa: 'D1', id: 'x2', content_json: JSON.stringify({ type: 'text', body: 'real content' }) },
      { wa: 'D2', id: 'x5', content_json: JSON.stringify({ type: 'text', body: 'earlier duplicate' }) },
    ]);
  });

  it('numbers account_seq by created_at when insertion order differs', () => {
    const rows = db.prepare(`SELECT id, account_seq FROM messages ORDER BY account_seq`).all() as Array<{ id: string; account_seq: number }>;
    expect(rows.map((r) => r.id)).toEqual(RANKED_EXPECTED);
    expect(rows.map((r) => r.account_seq)).toEqual([1, 2, 3]);
    expect(db.prepare(`SELECT n FROM account_counters WHERE account_id = 'acc-c'`).all()).toEqual([{ n: 3 }]);
  });
});

// ── History as production has it: outbound rows, placeholders, inline base64 ──

interface HistoryRow {
  id: string;
  account: string;
  direction?: 'inbound' | 'outbound';
  wa?: string;
  content?: Record<string, unknown>;
  createdAt?: string;
  preview?: string;
}

function historyColumns(row: HistoryRow) {
  const details = row.wa === undefined ? null : JSON.stringify({ platform: 'whatsapp', messageId: row.wa });
  const createdAt = row.createdAt ?? '2026-04-05T10:00:00.000Z';
  return [
    row.id, row.account, 'whatsapp', row.direction ?? 'inbound', 'conv-1', 'sender-1', 'Sender', 'recipient-1',
    'text', row.preview ?? `preview ${row.id}`, JSON.stringify(row.content ?? { type: 'text', body: row.id }), null, details,
    JSON.stringify({ adapterId: 'baileys' }), createdAt, createdAt,
  ];
}

const HISTORY_INSERT = `INSERT INTO messages (id, account_id, channel, direction, conversation_id, sender_id, sender_name,
  recipient_id, content_type, content_preview, content_json, context_json, channel_details_json,
  gateway_json, timestamp, created_at)`;

interface MigratedHistory {
  store: PostgresMessageStore | SqliteMessageStore;
  rows(sql: string): Promise<Array<Record<string, unknown>>>;
  dispose(): Promise<void>;
}

async function migrateSqliteHistory(rows: HistoryRow[]): Promise<MigratedHistory> {
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(':memory:');
  const legacyDir = await copyInitialMigration('sqlite');
  await new MigrationRunner({ scriptsDir: join(legacyDir, 'sqlite'), adapter: new SqliteMigrationAdapter(db), logger: silent }).run();
  const insert = db.prepare(`${HISTORY_INSERT} VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const row of rows) insert.run(...historyColumns(row));
  const store = new SqliteMessageStore(':memory:');
  (store as unknown as { db: unknown }).db = db;
  await store.runMigrations();
  return {
    store,
    rows: async (sql) => db.prepare(sql).all() as Array<Record<string, unknown>>,
    dispose: async () => {
      await store.close();
      await rm(legacyDir, { recursive: true, force: true });
    },
  };
}

async function migratePostgresHistory(rows: HistoryRow[]): Promise<MigratedHistory> {
  const { Pool } = await import('pg');
  const schema = `mlogh_${randomUUID().replace(/-/g, '')}`;
  const root = new Pool({ connectionString: PG_URL });
  await root.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(PG_URL!);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const admin = new Pool({ connectionString: url.toString() });
  const legacyDir = await copyInitialMigration('postgres');
  await new MigrationRunner({ scriptsDir: join(legacyDir, 'postgres'), adapter: new PostgresMigrationAdapter(admin), logger: silent }).run();
  for (const row of rows) {
    await admin.query(`${HISTORY_INSERT} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`, historyColumns(row));
  }
  const store = new PostgresMessageStore(url.toString());
  await store.init();
  await store.runMigrations();
  return {
    store,
    rows: async (sql) => (await admin.query(sql)).rows,
    dispose: async () => {
      await store.close();
      await admin.end();
      await root.query(`DROP SCHEMA "${schema}" CASCADE`);
      await root.end();
      await rm(legacyDir, { recursive: true, force: true });
    },
  };
}

function historySuite(name: string, migrate: (rows: HistoryRow[]) => Promise<MigratedHistory>, skip = false): void {
  describe.skipIf(skip)(`message-log migration over production-like history (${name})`, () => {
    let history: MigratedHistory | undefined;
    const run = async (rows: HistoryRow[]) => {
      history = await migrate(rows);
      return history;
    };

    afterEach(async () => {
      await history?.dispose();
      history = undefined;
    });

    it('numbers only inbound rows: historic outbound rows take no account_seq', async () => {
      const { rows, store } = await run([
        { id: 'in-1', account: 'acc-a', createdAt: '2026-04-05T10:00:00.000Z' },
        { id: 'out-1', account: 'acc-a', direction: 'outbound', createdAt: '2026-04-05T10:01:00.000Z' },
        { id: 'in-2', account: 'acc-a', createdAt: '2026-04-05T10:02:00.000Z' },
      ]);

      const seqs = await rows('SELECT id, account_seq FROM messages ORDER BY id');
      expect(seqs.map((r) => [r.id, r.account_seq === null ? null : Number(r.account_seq)])).toEqual([
        ['in-1', 1], ['in-2', 2], ['out-1', null],
      ]);
      expect(await store.maxAccountSeq('acc-a')).toBe(2);
      const page = await store.queryAfter({ accountId: 'acc-a', afterAccountSeq: 0, limit: 10 });
      expect(page.messages.map((m) => m.id)).toEqual(['in-1', 'in-2']);
    });

    it('survives an account that only has outbound history, whose first inbound message is number 1', async () => {
      const { store, rows } = await run([{ id: 'out-only', account: 'acc-out', direction: 'outbound' }]);

      expect(await rows('SELECT account_id FROM account_counters')).toEqual([]);
      expect((await store.insertInbound(makeEnvelope('acc-out', 'FIRST'))).accountSeq).toBe(1);
    });

    it('archives every row the dedupe removes, pointing at the row it kept', async () => {
      const { rows } = await run([
        { id: 'keep', account: 'acc-a', wa: 'W1', createdAt: '2026-04-05T10:00:00.000Z' },
        { id: 'gone-1', account: 'acc-a', wa: 'W1', createdAt: '2026-04-05T10:01:00.000Z', content: { type: 'text', body: 'first copy' } },
        { id: 'gone-2', account: 'acc-a', wa: 'W1', createdAt: '2026-04-05T10:02:00.000Z', content: { type: 'text', body: 'second copy' } },
        { id: 'unique', account: 'acc-a', wa: 'W2' },
      ]);

      const archived = await rows('SELECT id, account_id, kept_id, content_json, archived_at FROM messages_dedupe_archive ORDER BY id');
      expect(archived.map((r) => [r.id, r.account_id, r.kept_id])).toEqual([
        ['gone-1', 'acc-a', 'keep'], ['gone-2', 'acc-a', 'keep'],
      ]);
      const content = archived[0]!.content_json;
      expect(typeof content === 'string' ? JSON.parse(content) : content).toEqual({ type: 'text', body: 'first copy' });
      expect(archived[0]!.archived_at).toBeTruthy();
      expect((await rows('SELECT id FROM messages ORDER BY id')).map((r) => r.id)).toEqual(['keep', 'unique']);
    });

    it.each([
      ['an empty text stub', ''],
      ['an unsupported-type placeholder', '[Unsupported message type: unknown]'],
      ['an edited-message placeholder', '[Edited message]'],
    ])('keeps the row with content over an older %s', async (_label, body) => {
      const { rows } = await run([
        { id: 'stub', account: 'acc-a', wa: 'W1', createdAt: '2026-04-05T10:00:00.000Z', content: { type: 'text', body } },
        { id: 'real', account: 'acc-a', wa: 'W1', createdAt: '2026-04-05T10:01:00.000Z', content: { type: 'text', body: 'the real message' } },
      ]);

      expect((await rows('SELECT id FROM messages')).map((r) => r.id)).toEqual(['real']);
      expect((await rows('SELECT id, kept_id FROM messages_dedupe_archive'))).toEqual([{ id: 'stub', kept_id: 'real' }]);
    });

    it('never returns the historic inline base64 of a media on reads', async () => {
      const content = { type: 'image', media: { mimeType: 'image/jpeg', base64: 'QUJD', filename: 'a.jpg' } };
      const { store, rows } = await run([{ id: 'img', account: 'acc-a', wa: 'W1', content }]);

      const expected = { type: 'image', media: { mimeType: 'image/jpeg', filename: 'a.jpg' } };
      expect((await store.findById('img'))?.content).toEqual(expected);
      expect((await store.findByWaMessageId('acc-a', 'W1'))?.content).toEqual(expected);
      expect((await store.query({ accountId: 'acc-a' })).messages[0]?.content).toEqual(expected);
      expect((await store.queryAfter({ accountId: 'acc-a', afterAccountSeq: 0, limit: 10 })).messages[0]?.content).toEqual(expected);
      expect((await store.search('preview')).messages[0]?.content).toEqual(expected);
      expect((await store.getConversationHistory('conv-1')).envelopes[0]?.content).toEqual(expected);
      // The bytes stay in the row: reads leave them out, nothing was rewritten.
      const stored = (await rows('SELECT content_json FROM messages'))[0]!.content_json;
      expect(JSON.stringify(stored)).toContain('QUJD');
    });
  });
}

historySuite('sqlite', migrateSqliteHistory);
historySuite('postgres', migratePostgresHistory, !PG_URL);

describe.skipIf(!PG_URL)('message-log migration planner statistics (postgres)', () => {
  it('leaves the table analyzed', async () => {
    const history = await migratePostgresHistory([
      { id: 'a', account: 'acc-a', wa: 'W1' }, { id: 'b', account: 'acc-a', wa: 'W2' },
    ]);
    try {
      // pg_stats only has rows for a table ANALYZE has seen (autovacuum would take a minute at least).
      const stats = await history.rows(`SELECT attname FROM pg_stats WHERE schemaname = current_schema() AND tablename = 'messages'`);
      expect(stats.length).toBeGreaterThan(0);
    } finally {
      await history.dispose();
    }
  });
});

describe('message-log migration on sqlite: FTS and global seq', () => {
  let history: MigratedHistory;

  afterEach(async () => {
    await history.dispose();
  });

  it('leaves the table analyzed', async () => {
    history = await migrateSqliteHistory([{ id: 'a', account: 'acc-a', wa: 'W1' }, { id: 'b', account: 'acc-a', wa: 'W2' }]);
    expect((await history.rows(`SELECT tbl FROM sqlite_stat1 WHERE tbl = 'messages'`)).length).toBeGreaterThan(0);
  });

  it('finds historic rows after the migration, and the dedupe does not leave ghosts in the index', async () => {
    history = await migrateSqliteHistory([
      { id: 'old-1', account: 'acc-a', wa: 'W1', preview: 'tortilla de patatas' },
      { id: 'old-2', account: 'acc-a', wa: 'W1', preview: 'gazpacho fresco' },
      { id: 'old-3', account: 'acc-a', wa: 'W2', preview: 'paella valenciana' },
    ]);

    expect((await history.store.search('tortilla')).messages.map((m) => m.id)).toEqual(['old-1']);
    expect((await history.store.search('paella')).messages.map((m) => m.id)).toEqual(['old-3']);
    expect((await history.store.search('gazpacho')).total).toBe(0);
  });

  it('does not reuse a global seq once the highest row was deleted', async () => {
    history = await migrateSqliteHistory([{ id: 'a', account: 'acc-a', wa: 'W1' }]);
    const { store } = history;
    const last = await store.insertInbound(makeEnvelope('acc-a', 'W2'));
    await store.deleteOlderThan(-1);

    const next = await store.insertInbound(makeEnvelope('acc-a', 'W3'));

    expect(next.seq).toBeGreaterThan(last.seq!);
  });
});
