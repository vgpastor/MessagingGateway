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

const PG_URL = process.env.TEST_DATABASE_URL;

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

  it('removes duplicate WhatsApp ids keeping the lowest seq', async () => {
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
    expect(dup).toEqual({ inserted: false });

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
    expect(await store.insertInbound(makeEnvelope('acc-a', 'W2'))).toEqual({ inserted: false });
    const fresh = await store.insertInbound(makeEnvelope('acc-a', 'W3'));
    expect(fresh.accountSeq).toBe(6);
    expect(await store.maxAccountSeq('acc-b')).toBe(2);
  });
});
