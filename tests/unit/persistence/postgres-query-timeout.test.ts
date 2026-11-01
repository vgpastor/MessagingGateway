/**
 * The pool's query timeout, against a real Postgres: what hangs is a statement blocked by a lock
 * held from another connection, the closest a test gets to a network partition.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PoolClient, Pool } from 'pg';
import type { UnifiedEnvelope } from '../../../src/core/messaging/unified-envelope.js';
import { PostgresMessageStore } from '../../../src/persistence/postgres-message-store.js';

const PG_URL = process.env.TEST_DATABASE_URL;
const ACCOUNT = 'wa-1';
const TIMEOUT_MS = 1_000;

function envelope(id: string): UnifiedEnvelope {
  const when = new Date('2026-05-01T10:00:00.000Z');
  return {
    id,
    accountId: ACCOUNT,
    channel: 'whatsapp',
    direction: 'inbound',
    timestamp: when,
    sentAt: when,
    conversationId: 'c@s.whatsapp.net',
    sender: { id: 's@s.whatsapp.net' },
    recipient: { id: '+34600000001' },
    content: { type: 'text', body: 'hola' },
    channelDetails: { platform: 'whatsapp', messageId: `wa-${id}` },
    gateway: { receivedAt: when, adapterId: 'baileys', account: { id: ACCOUNT, alias: 'a', owner: 'o', tags: [] } },
  };
}

describe.skipIf(!PG_URL)('PostgresMessageStore query timeout', () => {
  let schema: string;
  let url: string;
  let root: Pool;
  let locker: PoolClient;
  let store: PostgresMessageStore;

  const open = async (queryTimeoutMs: number) => {
    const opened = new PostgresMessageStore(url, { queryTimeoutMs });
    await opened.init();
    return opened;
  };

  beforeEach(async () => {
    const { Pool: PgPool } = await import('pg');
    schema = `mgtimeout_${randomUUID().replace(/-/g, '')}`;
    root = new PgPool({ connectionString: PG_URL });
    await root.query(`CREATE SCHEMA "${schema}"`);
    const scoped = new URL(PG_URL!);
    scoped.searchParams.set('options', `-c search_path=${schema}`);
    url = scoped.toString();
    store = await open(TIMEOUT_MS);
    await store.runMigrations();
    locker = await root.connect();
    await locker.query(`SET search_path TO "${schema}"`);
  });

  afterEach(async () => {
    await locker.query('ROLLBACK');
    locker.release();
    await store.close();
    await root.query(`DROP SCHEMA "${schema}" CASCADE`);
    await root.end();
  });

  /** Holds the account's counter row, which every insert of the account needs. */
  const holdCounterRow = async () => {
    await locker.query('BEGIN');
    await locker.query(`INSERT INTO account_counters (account_id, n) VALUES ($1, 0)`, [ACCOUNT]);
  };

  it('a hung insert fails within the limit instead of holding the account queue for ever', async () => {
    await holdCounterRow();

    await expect(store.insertInbound(envelope('m1'))).rejects.toThrow('Query read timeout');
  });

  it('leaves nothing behind: the retry works, numbers contiguously, and the connection did not go back to the pool', async () => {
    await holdCounterRow();
    await expect(store.insertInbound(envelope('m1'))).rejects.toThrow('Query read timeout');
    await locker.query('ROLLBACK');

    const retry = await store.insertInbound(envelope('m1'));
    const next = await store.insertInbound(envelope('m2'));

    expect(retry).toMatchObject({ inserted: true, accountSeq: 1 });
    expect(next).toMatchObject({ inserted: true, accountSeq: 2 });
    expect(await store.count({ accountId: ACCOUNT })).toBe(2);
    const open = await root.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE state LIKE 'idle in transaction%' AND pid <> ALL($1::int[]) AND query ILIKE '%account_counters%'`,
      [[(await locker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid]],
    );
    expect(open.rows[0].n).toBe(0);
  });

  it('a hung read fails within the limit, and the pool serves the next one', async () => {
    await locker.query('BEGIN');
    await locker.query('LOCK TABLE messages IN ACCESS EXCLUSIVE MODE');

    await expect(store.count({ accountId: ACCOUNT })).rejects.toThrow('Query read timeout');

    await locker.query('ROLLBACK');
    await expect(store.count({ accountId: ACCOUNT })).resolves.toBe(0);
  });

  it('does not apply to migrations: the first run of 002 rewrites a whole table, and failing it would stop the gateway from starting', async () => {
    const { Pool: PgPool } = await import('pg');
    const fresh = `mgtimeout_${randomUUID().replace(/-/g, '')}`;
    await root.query(`CREATE SCHEMA "${fresh}"`);
    const scoped = new URL(PG_URL!);
    scoped.searchParams.set('options', `-c search_path=${fresh}`);
    const tight = new PostgresMessageStore(scoped.toString(), { queryTimeoutMs: 1 });
    try {
      await tight.init();
      await expect(tight.runMigrations()).resolves.toBeUndefined();

      const check = new PgPool({ connectionString: scoped.toString() });
      expect((await check.query('SELECT count(*)::int AS n FROM _migrations')).rows[0].n).toBeGreaterThan(0);
      await check.end();
    } finally {
      await tight.close();
      await root.query(`DROP SCHEMA "${fresh}" CASCADE`);
    }
  });

  it('does not apply to retention: a large delete takes its time, away from any queue', async () => {
    const tight = await open(200);
    try {
      await store.insertInbound(envelope('old'));
      await root.query(`UPDATE "${schema}".messages SET created_at = NOW() - interval '10 days'`);
      await locker.query('BEGIN');
      await locker.query(`SELECT id FROM messages WHERE id = 'old' FOR UPDATE`);

      const deleting = tight.deleteOlderThan(5);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await locker.query('COMMIT');

      await expect(deleting).resolves.toBe(1);
    } finally {
      await tight.close();
    }
  });
});
