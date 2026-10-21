/**
 * Message log: per-account contiguous `accountSeq`, dedupe by WhatsApp message id,
 * paged reads, media bookkeeping and retention.
 *
 * The same behavioural suite runs against SQLite (always) and PostgreSQL
 * (only when TEST_DATABASE_URL is set). Each Postgres test gets its own schema,
 * so runs are repeatable and isolated.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { UnifiedEnvelope } from '../../../src/core/messaging/unified-envelope.js';
import type { FullMessageStorePort } from '../../../src/core/persistence/message-store.port.js';
import { SqliteMessageStore } from '../../../src/persistence/sqlite-message-store.js';
import { PostgresMessageStore } from '../../../src/persistence/postgres-message-store.js';

// ── Fixtures ──────────────────────────────────────────────────────

let envelopeCounter = 0;

function makeEnvelope(accountId: string, waMessageId?: string, overrides: Partial<UnifiedEnvelope> = {}): UnifiedEnvelope {
  envelopeCounter += 1;
  const now = new Date('2026-04-05T10:00:00Z');
  return {
    id: `msg_${randomUUID()}`,
    accountId,
    channel: 'whatsapp',
    direction: 'inbound',
    timestamp: now,
    sentAt: now,
    conversationId: '34600000099@s.whatsapp.net',
    sender: { id: '34600000099@s.whatsapp.net', displayName: 'Customer' },
    recipient: { id: '+34600000001' },
    content: { type: 'text', body: `message ${envelopeCounter}` },
    channelDetails: waMessageId === undefined
      ? { platform: 'whatsapp' }
      : { platform: 'whatsapp', messageId: waMessageId },
    gateway: {
      receivedAt: now,
      adapterId: 'baileys',
      account: { id: accountId, alias: accountId, owner: 'test-org', tags: [] },
    },
    ...overrides,
  };
}

/** Everything the suite needs from a concrete backend */
interface Backend {
  store: FullMessageStorePort;
  /** Rewrite `created_at` of a message so retention can be tested deterministically */
  backdate(id: string, days: number): Promise<void>;
  dispose(): Promise<void>;
}

async function createSqliteBackend(): Promise<Backend> {
  const store = new SqliteMessageStore(':memory:');
  await store.init();
  await store.runMigrations();
  const db = (store as unknown as { db: import('better-sqlite3').Database }).db;
  return {
    store,
    backdate: async (id, days) => {
      const when = new Date(Date.now() - days * 86_400_000).toISOString();
      db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(when, id);
    },
    dispose: () => store.close(),
  };
}

const PG_URL = process.env.TEST_DATABASE_URL;

/** Postgres backend isolated in its own throw-away schema (search_path) */
async function createPostgresBackend(schemaSuffix = randomUUID().replace(/-/g, '')): Promise<Backend & { schema: string; admin: import('pg').Pool }> {
  const { Pool } = await import('pg');
  const schema = `mlog_${schemaSuffix}`;
  const admin = new Pool({ connectionString: PG_URL });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(PG_URL!);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const store = new PostgresMessageStore(url.toString());
  await store.init();
  await store.runMigrations();
  return {
    store,
    schema,
    admin,
    backdate: async (id, days) => {
      await admin.query(
        `UPDATE "${schema}".messages SET created_at = NOW() - ($2 || ' days')::interval WHERE id = $1`,
        [id, String(days)],
      );
    },
    dispose: async () => {
      await store.close();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    },
  };
}

// ── Shared behavioural suite ──────────────────────────────────────

function messageLogSuite(name: string, create: () => Promise<Backend>, skip = false): void {
  describe.skipIf(skip)(`MessageLog (${name})`, () => {
    let backend: Backend;
    let store: FullMessageStorePort;

    beforeEach(async () => {
      backend = await create();
      store = backend.store;
    });

    afterEach(async () => {
      await backend.dispose();
    });

    it('insertInbound assigns contiguous accountSeq per account', async () => {
      const a = [];
      for (const id of ['A1', 'A2', 'A3']) a.push(await store.insertInbound(makeEnvelope('acc-a', id)));
      const b = await store.insertInbound(makeEnvelope('acc-b', 'B1'));

      expect(a.map((x) => x.accountSeq)).toEqual([1, 2, 3]);
      expect(a.every((x) => x.inserted)).toBe(true);
      expect(b.accountSeq).toBe(1);
      // global seq is unique and increasing
      const seqs = [...a, b].map((x) => x.seq as number);
      expect(new Set(seqs).size).toBe(4);
      expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
      expect(seqs.every((s) => typeof s === 'number')).toBe(true);
    });

    it('insertInbound dedupes by waMessageId without consuming accountSeq', async () => {
      const first = await store.insertInbound(makeEnvelope('acc-a', 'M1'));
      const dup = await store.insertInbound(makeEnvelope('acc-a', 'M1'));
      const next = await store.insertInbound(makeEnvelope('acc-a', 'M2'));

      expect(first).toMatchObject({ inserted: true, accountSeq: 1 });
      expect(dup).toEqual({ inserted: false });
      expect(next.accountSeq).toBe(2);
      expect(await store.maxAccountSeq('acc-a')).toBe(2);
      expect(await store.count({ accountId: 'acc-a' })).toBe(2);
    });

    it('insertInbound treats the same waMessageId in another account as a different message', async () => {
      const a = await store.insertInbound(makeEnvelope('acc-a', 'SAME'));
      const b = await store.insertInbound(makeEnvelope('acc-b', 'SAME'));
      expect(a.inserted).toBe(true);
      expect(b.inserted).toBe(true);
    });

    it('insertInbound allows multiple null waMessageId', async () => {
      const r1 = await store.insertInbound(makeEnvelope('acc-a'));
      const r2 = await store.insertInbound(makeEnvelope('acc-a'));
      const r3 = await store.insertInbound(makeEnvelope('acc-a', ''));
      expect([r1.inserted, r2.inserted, r3.inserted]).toEqual([true, true, true]);
      expect([r1.accountSeq, r2.accountSeq, r3.accountSeq]).toEqual([1, 2, 3]);
    });

    it('insertInbound keeps accountSeq contiguous under concurrent inserts and duplicates', async () => {
      const unique = await Promise.all(
        Array.from({ length: 20 }, (_, i) => store.insertInbound(makeEnvelope('acc-a', `C${i}`))),
      );
      expect(unique.map((r) => r.accountSeq).sort((x, y) => (x as number) - (y as number)))
        .toEqual(Array.from({ length: 20 }, (_, i) => i + 1));

      const dups = await Promise.all(
        Array.from({ length: 6 }, () => store.insertInbound(makeEnvelope('acc-a', 'DUP'))),
      );
      expect(dups.filter((r) => r.inserted)).toHaveLength(1);
      expect(await store.maxAccountSeq('acc-a')).toBe(21);
      expect(await store.count({ accountId: 'acc-a' })).toBe(21);
    });

    it('insertInbound persists seq, accountSeq, sentAt and raw, and returns them on read', async () => {
      const sentAt = new Date('2026-04-05T09:59:58.000Z');
      const raw = { key: { id: 'R1' }, message: { conversation: 'hola' } };
      const env = makeEnvelope('acc-a', 'R1', { sentAt });
      const res = await store.insertInbound(env, raw);

      const found = await store.findById(env.id);
      expect(found?.seq).toBe(res.seq);
      expect(found?.accountSeq).toBe(1);
      expect(found?.sentAt?.toISOString()).toBe(sentAt.toISOString());

      const byWa = await store.findByWaMessageId('acc-a', 'R1');
      expect(byWa?.id).toBe(env.id);
      expect(byWa?.raw).toEqual(raw);
      expect(await store.findByWaMessageId('acc-b', 'R1')).toBeUndefined();
      expect(await store.findByWaMessageId('acc-a', 'nope')).toBeUndefined();
    });

    it('save() (outbound) keeps working and does not take an accountSeq', async () => {
      await store.insertInbound(makeEnvelope('acc-a', 'I1'));
      await store.save(makeEnvelope('acc-a', 'O1', { direction: 'outbound' }));
      const next = await store.insertInbound(makeEnvelope('acc-a', 'I2'));
      expect(next.accountSeq).toBe(2);
      expect(await store.maxAccountSeq('acc-a')).toBe(2);
    });

    it('queryAfter pages ascending by accountSeq', async () => {
      for (let i = 1; i <= 5; i++) await store.insertInbound(makeEnvelope('acc-a', `P${i}`));
      await store.insertInbound(makeEnvelope('acc-b', 'other'));

      const page1 = await store.queryAfter({ accountId: 'acc-a', afterAccountSeq: 2, limit: 2 });
      expect(page1.messages.map((m) => m.accountSeq)).toEqual([3, 4]);
      expect(page1.nextAfterAccountSeq).toBe(4);

      const page2 = await store.queryAfter({ accountId: 'acc-a', afterAccountSeq: 4, limit: 2 });
      expect(page2.messages.map((m) => m.accountSeq)).toEqual([5]);
      expect(page2.nextAfterAccountSeq).toBeNull();

      const exact = await store.queryAfter({ accountId: 'acc-a', afterAccountSeq: 3, limit: 2 });
      expect(exact.messages.map((m) => m.accountSeq)).toEqual([4, 5]);
      expect(exact.nextAfterAccountSeq).toBeNull();

      const empty = await store.queryAfter({ accountId: 'acc-a', afterAccountSeq: 5, limit: 10 });
      expect(empty).toEqual({ messages: [], nextAfterAccountSeq: null });
    });

    it('queryAfter caps limit at 500', async () => {
      for (let i = 1; i <= 501; i++) await store.insertInbound(makeEnvelope('acc-a', `L${i}`));
      const res = await store.queryAfter({ accountId: 'acc-a', afterAccountSeq: 0, limit: 10_000 });
      expect(res.messages).toHaveLength(500);
      expect(res.nextAfterAccountSeq).toBe(500);
    }, 60_000);

    it('maxAccountSeq returns 0 for unknown account', async () => {
      expect(await store.maxAccountSeq('ghost')).toBe(0);
    });

    it('deleteOlderThan removes messages by created_at and never reuses accountSeq', async () => {
      const old = makeEnvelope('acc-a', 'OLD');
      const fresh = makeEnvelope('acc-a', 'NEW');
      await store.insertInbound(old);
      await store.insertInbound(fresh);
      await backend.backdate(old.id, 40);

      const removed = await store.deleteOlderThan(30);
      expect(removed).toBe(1);
      expect(await store.findById(old.id)).toBeUndefined();
      expect(await store.findById(fresh.id)).toBeDefined();

      const next = await store.insertInbound(makeEnvelope('acc-a', 'AFTER'));
      expect(next.accountSeq).toBe(3);
    });

    it('findPendingMedia returns raw for pending media and updateMedia merges the result', async () => {
      const pending = makeEnvelope('acc-a', 'IMG1', {
        content: { type: 'image', media: { mimeType: 'image/jpeg', status: 'pending' } },
      } as Partial<UnifiedEnvelope>);
      const raw = { key: { id: 'IMG1' }, message: { imageMessage: {} } };
      await store.insertInbound(pending, raw);
      await store.insertInbound(makeEnvelope('acc-a', 'TXT1'), { key: { id: 'TXT1' } });

      const found = await store.findPendingMedia(10);
      expect(found).toEqual([{ id: pending.id, accountId: 'acc-a', raw }]);

      await store.updateMedia(pending.id, { status: 'ready', size: 10, url: `/api/v1/media/${pending.id}` } as never);
      const updated = await store.findById(pending.id);
      const media = (updated?.content as unknown as { media: Record<string, unknown> }).media;
      expect(media).toMatchObject({ mimeType: 'image/jpeg', status: 'ready', size: 10 });
      expect(await store.findPendingMedia(10)).toEqual([]);
    });
  });
}

messageLogSuite('sqlite', createSqliteBackend);
messageLogSuite('postgres', () => createPostgresBackend(), !PG_URL);
