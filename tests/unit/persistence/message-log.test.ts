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
import { MAX_EXPORT_LIMIT, MAX_PAGE_LIMIT } from '../../../src/core/persistence/message-store.utils.js';
import { PermanentStoreError } from '../../../src/core/errors.js';

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
  /** Makes any UPDATE of `account_seq` fail: a message must be written once, with its number */
  forbidAccountSeqUpdates(): Promise<void>;
  /** Sets the account's counter behind the numbers already handed out, which should never happen */
  rewindCounter(accountId: string, n: number): Promise<void>;
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
    forbidAccountSeqUpdates: async () => {
      db.exec(`CREATE TRIGGER no_seq_update BEFORE UPDATE OF account_seq ON messages BEGIN SELECT RAISE(ABORT, 'second write'); END`);
    },
    rewindCounter: async (accountId, n) => {
      db.prepare('UPDATE account_counters SET n = ? WHERE account_id = ?').run(n, accountId);
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
    forbidAccountSeqUpdates: async () => {
      await admin.query(`
        CREATE FUNCTION "${schema}".no_seq_update() RETURNS trigger AS $fn$ BEGIN RAISE EXCEPTION 'second write'; END $fn$ LANGUAGE plpgsql;
        CREATE TRIGGER no_seq_update BEFORE UPDATE OF account_seq ON "${schema}".messages
          FOR EACH ROW EXECUTE FUNCTION "${schema}".no_seq_update();
      `);
    },
    rewindCounter: async (accountId, n) => {
      await admin.query(`UPDATE "${schema}".account_counters SET n = $1 WHERE account_id = $2`, [n, accountId]);
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
      expect(dup).toMatchObject({ inserted: false });
      expect(next.accountSeq).toBe(2);
      expect(await store.maxAccountSeq('acc-a')).toBe(2);
      expect(await store.count({ accountId: 'acc-a' })).toBe(2);
    });

    it('insertInbound writes a message once, with its number already on it', async () => {
      await backend.forbidAccountSeqUpdates();

      expect(await store.insertInbound(makeEnvelope('acc-a', 'ONE'))).toMatchObject({ inserted: true, accountSeq: 1 });
      expect(await store.insertInbound(makeEnvelope('acc-a', 'TWO'))).toMatchObject({ inserted: true, accountSeq: 2 });
      expect((await store.queryAfter({ accountId: 'acc-a', afterAccountSeq: 0, limit: 10 })).messages.map((m) => m.accountSeq)).toEqual([1, 2]);
    });

    it('a duplicate of an account with no messages leaves no counter behind', async () => {
      const stored = makeEnvelope('acc-a', 'SAME-ID');
      await store.insertInbound(stored);

      const sameIdOtherAccount = await store.insertInbound({ ...stored, accountId: 'acc-new', channelDetails: { platform: 'whatsapp', messageId: 'OTHER' } });

      expect(sameIdOtherAccount).toMatchObject({ inserted: false });
      expect(await store.maxAccountSeq('acc-new')).toBe(0);
    });

    it('a duplicate says which row already holds the message, and its numbers', async () => {
      const stored = makeEnvelope('acc-a', 'HELD');
      const first = await store.insertInbound(stored);

      expect(await store.insertInbound(stored)).toEqual({
        inserted: false, storedId: stored.id, seq: first.seq, accountSeq: first.accountSeq,
      });
      expect(await store.insertInbound(makeEnvelope('acc-a', 'HELD'))).toEqual({
        inserted: false, storedId: stored.id, seq: first.seq, accountSeq: first.accountSeq,
      });
    });

    it('a number already taken is a failure, never a duplicate that would drop the message', async () => {
      await store.insertInbound(makeEnvelope('acc-a', 'S1'));
      await store.insertInbound(makeEnvelope('acc-a', 'S2'));
      await backend.rewindCounter('acc-a', 1);

      const message = makeEnvelope('acc-a', 'S3');
      await expect(store.insertInbound(message)).rejects.toBeInstanceOf(PermanentStoreError);

      expect(await store.findById(message.id)).toBeUndefined();
      expect(await store.maxAccountSeq('acc-a')).toBe(1);
    });

    it('a message the database refuses is a permanent failure, and consumes no number', async () => {
      await store.insertInbound(makeEnvelope('acc-a', 'OK'));
      const refused = makeEnvelope('acc-a', 'BAD', { recipient: { id: null as unknown as string } });

      await expect(store.insertInbound(refused)).rejects.toBeInstanceOf(PermanentStoreError);

      expect(await store.maxAccountSeq('acc-a')).toBe(1);
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

    it('queryAfter, findById and findByWaMessageId return sender phone/lid, sentAt, seq and accountSeq exactly as inserted', async () => {
      const sentAt = new Date('2026-04-05T09:59:58.000Z');
      const env = makeEnvelope('acc-a', 'ID1', {
        sentAt,
        sender: { id: '144980999962625@lid', displayName: 'Customer', phone: '+34600111222', lid: '144980999962625@lid' },
      });
      const res = await store.insertInbound(env);

      const { messages } = await store.queryAfter({ accountId: 'acc-a', afterAccountSeq: 0, limit: 10 });
      expect(messages).toHaveLength(1);
      expect(messages[0]?.sender).toEqual({ id: '144980999962625@lid', displayName: 'Customer', phone: '+34600111222', lid: '144980999962625@lid' });
      expect(messages[0]?.sentAt?.toISOString()).toBe(sentAt.toISOString());
      expect(messages[0]?.seq).toBe(res.seq);
      expect(messages[0]?.accountSeq).toBe(1);

      expect((await store.findById(env.id))?.sender).toMatchObject({ phone: '+34600111222', lid: '144980999962625@lid' });
      expect((await store.findByWaMessageId('acc-a', 'ID1'))?.sender).toMatchObject({ phone: '+34600111222', lid: '144980999962625@lid' });
    });

    it('a sender without phone/lid comes back without those keys', async () => {
      await store.insertInbound(makeEnvelope('acc-a', 'NOID'));

      const { messages } = await store.queryAfter({ accountId: 'acc-a', afterAccountSeq: 0, limit: 10 });
      expect(messages[0]?.sender).toEqual({ id: '34600000099@s.whatsapp.net', displayName: 'Customer' });
      expect(messages[0]?.sender).not.toHaveProperty('phone');
      expect(messages[0]?.sender).not.toHaveProperty('lid');
    });

    it('save() also persists sender phone/lid', async () => {
      const env = makeEnvelope('acc-a', 'S1', {
        direction: 'outbound',
        sender: { id: '+34600000001', phone: '+34600000001', lid: '1@lid' },
      });
      await store.save(env);

      expect((await store.findById(env.id))?.sender).toMatchObject({ phone: '+34600000001', lid: '1@lid' });
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

    it('stores NUL characters and lone surrogates by cleaning them, in text, JSON and raw', async () => {
      const env = makeEnvelope('acc-a', 'NUL1', {
        sender: { id: 'sender\u0000-1', displayName: 'Ana\u0000 \ud83d' },
        content: { type: 'text', body: 'ho\u0000la \ud83d' },
        context: { quotedMessageId: 'q\u0000' } as never,
      });
      const raw = { key: { id: 'NUL1' }, 'we\u0000ird': 'a\u0000b', nested: [{ text: 'c\u0000d \udc00' }], literal: 'back\\u0000slash' };

      const res = await store.insertInbound(env, raw);

      expect(res.inserted).toBe(true);
      const found = await store.findByWaMessageId('acc-a', 'NUL1');
      expect(found?.sender.displayName).toBe('Ana �');
      expect(found?.sender.id).toBe('sender-1');
      expect(found?.content).toEqual({ type: 'text', body: 'hola �' });
      // A literal backslash + u0000 is not a NUL: it must survive untouched.
      expect(found?.raw).toEqual({ key: { id: 'NUL1' }, weird: 'ab', nested: [{ text: 'cd �' }], literal: 'back\\u0000slash' });
    });

    it('save() and updateMedia() clean NUL characters too', async () => {
      const env = makeEnvelope('acc-a', 'NUL2', {
        direction: 'outbound',
        content: { type: 'image', caption: 'fo\u0000to', media: { mimeType: 'image/jpeg', status: 'pending' } },
      } as Partial<UnifiedEnvelope>);
      await store.save(env);
      await store.updateMedia(env.id, { filename: 'a\u0000.jpg' });

      const media = ((await store.findById(env.id))?.content as unknown as { caption: string; media: Record<string, unknown> });
      expect(media.caption).toBe('foto');
      expect(media.media.filename).toBe('a.jpg');
    });

    it('caps the page size of every read, whatever the caller asks for', async () => {
      await store.save(makeEnvelope('acc-a', 'CAP1'));

      expect((await store.query({ limit: 1_000_000 })).limit).toBe(MAX_EXPORT_LIMIT);
      expect((await store.query({ limit: -1 })).limit).toBe(1);
      expect((await store.query({})).limit).toBe(50);
      expect((await store.search('message', { limit: 1_000_000 })).limit).toBe(MAX_PAGE_LIMIT);
      expect((await store.search('message', { limit: -1 })).limit).toBe(1);

      const history = await store.getConversationHistory('34600000099@s.whatsapp.net', { limit: -1 });
      expect(history.envelopes).toHaveLength(1);
    });

    it('insertInbound is idempotent: the same envelope again is a duplicate, with or without a WhatsApp id', async () => {
      const withWa = makeEnvelope('acc-a', 'IDEM');
      const withoutWa = makeEnvelope('acc-a');

      expect((await store.insertInbound(withWa)).accountSeq).toBe(1);
      expect((await store.insertInbound(withoutWa)).accountSeq).toBe(2);

      expect(await store.insertInbound(withWa)).toMatchObject({ inserted: false });
      expect(await store.insertInbound(withoutWa)).toMatchObject({ inserted: false });
      expect(await store.maxAccountSeq('acc-a')).toBe(2);
      expect((await store.insertInbound(makeEnvelope('acc-a', 'NEXT'))).accountSeq).toBe(3);
    });

    it('save() keeps the raw payload of a sent message and finds it by its WhatsApp id, without taking an accountSeq', async () => {
      const raw = { key: { id: 'OUT1' }, message: { conversation: 'hola' } };
      const env = makeEnvelope('acc-a', 'OUT1', { direction: 'outbound' });

      await store.save(env, raw);

      const found = await store.findByWaMessageId('acc-a', 'OUT1');
      expect(found?.id).toBe(env.id);
      expect(found?.raw).toEqual(raw);
      expect(found?.accountSeq).toBeUndefined();
      expect(await store.maxAccountSeq('acc-a')).toBe(0);
    });

    it('minAccountSeq is the lowest number still stored, so a consumer can tell retention from a lost message', async () => {
      expect(await store.minAccountSeq('acc-a')).toBeNull();
      const old = makeEnvelope('acc-a', 'FIRST-OLD');
      await store.insertInbound(old);
      await store.insertInbound(makeEnvelope('acc-a', 'FIRST-NEW'));
      await store.save(makeEnvelope('acc-a', 'FIRST-OUT', { direction: 'outbound' }));
      expect(await store.minAccountSeq('acc-a')).toBe(1);

      await backend.backdate(old.id, 40);
      await store.deleteOlderThan(30);

      expect(await store.minAccountSeq('acc-a')).toBe(2);
    });

    it('search finds what is left after deleting, and no longer finds what was deleted', async () => {
      const gone = makeEnvelope('acc-a', 'S-GONE', { content: { type: 'text', body: 'tortilla de patatas' } });
      const kept = makeEnvelope('acc-a', 'S-KEPT', { content: { type: 'text', body: 'paella valenciana' } });
      const later = makeEnvelope('acc-a', 'S-LATER', { content: { type: 'text', body: 'gazpacho fresco' } });
      await store.insertInbound(gone);
      await store.insertInbound(kept);
      await backend.backdate(gone.id, 40);
      await store.deleteOlderThan(30);
      await store.insertInbound(later);

      expect((await store.search('tortilla')).total).toBe(0);
      expect((await store.search('paella')).messages.map((m) => m.id)).toEqual([kept.id]);
      expect((await store.search('gazpacho')).messages.map((m) => m.id)).toEqual([later.id]);
    });

    it('save() twice with the same id updates the row: it keeps its seq and stays searchable by the new text', async () => {
      const env = makeEnvelope('acc-a', 'U1', { direction: 'outbound', content: { type: 'text', body: 'primera version' } });
      await store.save(env);
      const before = await store.findById(env.id);

      await store.save({ ...env, content: { type: 'text', body: 'segunda version' } });

      const after = await store.findById(env.id);
      expect(after?.seq).toBe(before?.seq);
      expect(after?.content).toEqual({ type: 'text', body: 'segunda version' });
      expect((await store.search('segunda')).messages.map((m) => m.id)).toEqual([env.id]);
      expect((await store.search('primera')).total).toBe(0);
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

// ── Postgres going away under the store ──────────────────────────

describe.skipIf(!PG_URL)('PostgresMessageStore when connections die', () => {
  let backend: Awaited<ReturnType<typeof createPostgresBackend>>;

  beforeEach(async () => {
    backend = await createPostgresBackend();
  });

  afterEach(async () => {
    await backend.dispose();
  });

  const uncaught = () => {
    const errors: unknown[] = [];
    const onError = (err: unknown) => { errors.push(err); };
    process.on('uncaughtException', onError);
    return { errors, stop: () => process.off('uncaughtException', onError) };
  };

  it('bounds the wait for a connection', () => {
    const pool = (backend.store as unknown as { pool: { options: { connectionTimeoutMillis?: number } } }).pool;
    expect(pool.options.connectionTimeoutMillis).toBeGreaterThan(0);
  });

  it('survives an idle connection being terminated and keeps working on a new one', async () => {
    const { errors, stop } = uncaught();
    try {
      const pool = (backend.store as unknown as { pool: import('pg').Pool }).pool;
      const { rows: [{ pid }] } = await pool.query('SELECT pg_backend_pid() AS pid');
      await backend.admin.query('SELECT pg_terminate_backend($1)', [pid]);
      await new Promise((r) => setTimeout(r, 200));

      const res = await backend.store.insertInbound(makeEnvelope('acc-a', 'AFTER-RESTART'));

      expect(res.inserted).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      stop();
    }
  });

  it('survives the connection of a running insert being terminated: the insert fails and the next one works', async () => {
    const { errors, stop } = uncaught();
    const locker = await backend.admin.connect();
    try {
      // Hold the account counter so the insert stays parked with its connection checked out.
      await backend.store.insertInbound(makeEnvelope('acc-a', 'SEED'));
      await locker.query('BEGIN');
      await locker.query(`SELECT n FROM "${backend.schema}".account_counters WHERE account_id = 'acc-a' FOR UPDATE`);

      const parked = backend.store.insertInbound(makeEnvelope('acc-a', 'PARKED'));
      const parkedResult = parked.then(() => 'inserted', (err: Error) => err.message);
      let pid: number | undefined;
      for (let i = 0; i < 50 && pid === undefined; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const { rows } = await backend.admin.query(
          `SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%INTO account_counters%'`,
        );
        pid = rows[0]?.pid;
      }
      expect(pid).toBeDefined();
      await backend.admin.query('SELECT pg_terminate_backend($1)', [pid]);

      expect(await parkedResult).not.toBe('inserted');
      await locker.query('ROLLBACK');
      expect(errors).toEqual([]);
      const next = await backend.store.insertInbound(makeEnvelope('acc-a', 'NEXT'));
      expect(next.accountSeq).toBe(2);
    } finally {
      locker.release();
      stop();
    }
  });
});
