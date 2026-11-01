import { describe, it, expect, vi, afterEach } from 'vitest';
import { getLogger, setGlobalLogger, type Logger } from '../../../src/core/logger/logger.port.js';
import { EventBus } from '../../../src/core/event-bus.js';
import { Events } from '../../../src/core/events.js';
import type { MessageInboundPayload } from '../../../src/core/events.js';
import { InboundPipeline } from '../../../src/core/inbound/inbound-pipeline.js';
import type { FailedInboundLog } from '../../../src/core/inbound/failed-inbound-log.js';
import { PERSIST_RETRY_DELAYS_MS } from '../../../src/core/inbound/inbound-pipeline.js';
import type { MediaService } from '../../../src/core/inbound/media-service.js';
import type { MessageLogPort, InsertResult } from '../../../src/core/persistence/message-store.port.js';
import { noopMetrics, type MetricsPort } from '../../../src/core/metrics/metrics.port.js';
import type { ChannelAccount } from '../../../src/core/accounts/channel-account.js';
import type { UnifiedEnvelope } from '../../../src/core/messaging/unified-envelope.js';

function makeAccount(overrides: Partial<ChannelAccount> = {}): ChannelAccount {
  return {
    id: 'wa-1',
    alias: 'WA 1',
    channel: 'whatsapp',
    provider: 'baileys',
    status: 'active',
    identity: { channel: 'whatsapp', phoneNumber: '+34600000001' },
    credentialsRef: '',
    providerConfig: {},
    metadata: { owner: 'org', environment: 'production', tags: [] },
    ...overrides,
  };
}

function makeEnvelope(overrides: Partial<UnifiedEnvelope> = {}): UnifiedEnvelope {
  return {
    id: 'msg_1',
    accountId: 'wa-1',
    channel: 'whatsapp',
    direction: 'inbound',
    timestamp: new Date('2026-04-05T10:00:00Z'),
    conversationId: '34600111222@s.whatsapp.net',
    sender: { id: '34600111222@s.whatsapp.net', phone: '+34600111222' },
    recipient: { id: '+34600000001' },
    content: { type: 'text', body: 'hola' },
    channelDetails: { platform: 'whatsapp', messageId: 'WAID1' },
    gateway: {
      receivedAt: new Date('2026-04-05T10:00:00Z'),
      adapterId: 'baileys',
      account: { id: 'wa-1', alias: 'WA 1', owner: 'org', tags: [] },
    },
    ...overrides,
  };
}

function makeImageEnvelope(): UnifiedEnvelope {
  return makeEnvelope({
    content: { type: 'image', media: { mimeType: 'image/jpeg', base64: 'AAAA', filename: 'a.jpg' } } as UnifiedEnvelope['content'],
  });
}

function setup(opts: {
  insert?: InsertResult | Error | null; // null => storage disabled
  resolveLidToPhone?: (accountId: string, lid: string) => Promise<string | undefined>;
  toStorableRaw?: (raw: unknown) => unknown;
  persistRetryDelaysMs?: readonly number[];
  account?: ChannelAccount | undefined;
} = {}) {
  const eventBus = new EventBus();
  const emitted: UnifiedEnvelope[] = [];
  eventBus.on<MessageInboundPayload>(Events.MESSAGE_INBOUND, (e) => { emitted.push({ ...e.data.envelope }); });
  const emitSpy = vi.spyOn(eventBus, 'emit');

  const insertInbound = vi.fn(async (): Promise<InsertResult> => {
    if (opts.insert instanceof Error) throw opts.insert;
    return opts.insert ?? { inserted: true, seq: 10, accountSeq: 3 };
  });
  const store = opts.insert === null ? undefined : ({ insertInbound } as unknown as MessageLogPort);
  const media: MediaService = { process: vi.fn(async () => {}), resumePendingMedia: vi.fn(async () => 0) };
  const metrics: MetricsPort = {
    incCounter: vi.fn(), decGauge: vi.fn(), incGauge: vi.fn(), observeHistogram: vi.fn(), persistFailures: vi.fn(),
    mediaSkipped: vi.fn(), inboundSkipped: vi.fn(), lastInbound: vi.fn(),
  };
  const failedLog: FailedInboundLog = { append: vi.fn(async () => {}), replay: vi.fn(async () => ({ saved: 0, kept: 0 })) };
  const pipeline = new InboundPipeline({
    store, failedLog, eventBus, media, metrics,
    accounts: { findById: async () => ('account' in opts ? opts.account : makeAccount()) },
    resolveLidToPhone: opts.resolveLidToPhone,
    toStorableRaw: opts.toStorableRaw,
    persistRetryDelaysMs: opts.persistRetryDelaysMs ?? [],
  });
  return { pipeline, insertInbound, emitSpy, emitted, media, metrics, failedLog };
}

const raw = { key: { id: 'WAID1' } } as never;
const originalLogger = getLogger();

describe('InboundPipeline', () => {
  it('drops conversations outside account allowlist', async () => {
    const { pipeline, insertInbound, emitSpy } = setup();
    const account = makeAccount({ conversations: ['g1@g.us'] });

    await pipeline.handle(account, makeEnvelope({ conversationId: 'g2@g.us' }), raw);
    expect(insertInbound).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();

    await pipeline.handle(account, makeEnvelope({ conversationId: 'g1@g.us' }), raw);
    expect(insertInbound).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledTimes(1);
  });

  it('accepts every conversation when the allowlist is "*" or absent', async () => {
    const { pipeline, insertInbound } = setup();

    await pipeline.handle(makeAccount({ conversations: '*' }), makeEnvelope(), raw);
    await pipeline.handle(makeAccount(), makeEnvelope(), raw);

    expect(insertInbound).toHaveBeenCalledTimes(2);
  });

  it('records the last inbound timestamp (seconds since epoch) per account for every emitted message', async () => {
    const { pipeline, metrics } = setup();
    const before = Math.floor(Date.now() / 1000);

    await pipeline.handle(makeAccount({ id: 'wa-1' }), makeEnvelope(), raw);

    expect(metrics.lastInbound).toHaveBeenCalledTimes(1);
    const [account, ts] = vi.mocked(metrics.lastInbound).mock.calls[0]!;
    expect(account).toBe('wa-1');
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Math.ceil(Date.now() / 1000));
  });

  it('does not record the last inbound timestamp for filtered messages or duplicates', async () => {
    const { pipeline, metrics } = setup({ insert: { inserted: false } as InsertResult });

    await pipeline.handle(makeAccount({ conversations: ['other@g.us'] }), makeEnvelope(), raw);
    await pipeline.handle(makeAccount(), makeEnvelope(), raw);

    expect(metrics.lastInbound).not.toHaveBeenCalled();
  });

  it('emits after insert with seq and accountSeq', async () => {
    const { pipeline, insertInbound, emitSpy, emitted } = setup({ insert: { inserted: true, seq: 10, accountSeq: 3 } });

    await pipeline.handle(makeAccount(), makeEnvelope(), raw);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].seq).toBe(10);
    expect(emitted[0].accountSeq).toBe(3);
    expect(insertInbound.mock.invocationCallOrder[0]).toBeLessThan(emitSpy.mock.invocationCallOrder[0]);
  });

  it('emits MESSAGE_INBOUND for the account with the provider as source', async () => {
    const { pipeline, emitSpy } = setup();

    await pipeline.handle(makeAccount(), makeEnvelope(), raw);

    expect(emitSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: Events.MESSAGE_INBOUND, source: 'baileys', accountId: 'wa-1',
    }));
  });

  it('does not emit duplicates', async () => {
    const { pipeline, emitSpy, media } = setup({ insert: { inserted: false } });

    await pipeline.handle(makeAccount(), makeImageEnvelope(), raw);

    expect(emitSpy).not.toHaveBeenCalled();
    expect(media.process).not.toHaveBeenCalled();
  });

  describe('when the store fails', () => {
    it('retries with growing waits (about 30 s in total) and carries on with the sequence when it recovers', async () => {
      vi.useFakeTimers();
      try {
        const { pipeline, insertInbound, emitted, metrics, failedLog } = setup({ persistRetryDelaysMs: PERSIST_RETRY_DELAYS_MS });
        insertInbound.mockRejectedValueOnce(new Error('db down')).mockRejectedValueOnce(new Error('db down'));

        const done = pipeline.handle(makeAccount(), makeEnvelope(), raw);
        await vi.advanceTimersByTimeAsync(999);
        expect(insertInbound).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(insertInbound).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(2_000);
        await done;

        expect(insertInbound).toHaveBeenCalledTimes(3);
        expect(emitted[0].accountSeq).toBe(3);
        expect(metrics.persistFailures).not.toHaveBeenCalled();
        expect(failedLog.append).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('takes 5 retries and about 30 s before giving up', async () => {
      expect(PERSIST_RETRY_DELAYS_MS).toHaveLength(5);
      const total = PERSIST_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0);
      expect(total).toBeGreaterThanOrEqual(30_000);
      expect(total).toBeLessThan(32_000);
    });

    it('writes the message off to the failed log after the last retry, counts it, and still delivers it live without a sequence', async () => {
      const toStorableRaw = vi.fn(() => ({ stored: true }));
      const { pipeline, insertInbound, emitted, metrics, failedLog } = setup({
        insert: new Error('db down'), toStorableRaw, persistRetryDelaysMs: [0, 0, 0, 0, 0],
      });
      const envelope = makeEnvelope();

      await pipeline.handle(makeAccount(), envelope, raw);

      expect(insertInbound).toHaveBeenCalledTimes(6);
      expect(failedLog.append).toHaveBeenCalledTimes(1);
      expect(failedLog.append).toHaveBeenCalledWith({ envelope, raw: { stored: true } });
      expect(metrics.persistFailures).toHaveBeenCalledTimes(1);
      expect(emitted).toHaveLength(1);
      expect(emitted[0].seq).toBeUndefined();
      expect(emitted[0].accountSeq).toBeUndefined();
    });

    it('holds the next message of the account until the retries are over, so the order is kept', async () => {
      const { pipeline, insertInbound } = setup({ persistRetryDelaysMs: [20] });
      insertInbound.mockRejectedValueOnce(new Error('db down'));

      const first = pipeline.handle(makeAccount(), makeEnvelope({ id: 'm1' }), raw);
      const second = pipeline.handle(makeAccount(), makeEnvelope({ id: 'm2' }), raw);
      await new Promise((r) => setTimeout(r, 5));
      expect(insertInbound).toHaveBeenCalledTimes(1);
      await Promise.all([first, second]);

      const ids = (insertInbound.mock.calls as unknown as Array<[UnifiedEnvelope]>).map(([e]) => e.id);
      expect(ids).toEqual(['m1', 'm1', 'm2']);
    });

    it('survives the failed log failing too', async () => {
      const { pipeline, emitted, failedLog } = setup({ insert: new Error('db down') });
      vi.mocked(failedLog.append).mockRejectedValue(new Error('disk full'));

      await expect(pipeline.handle(makeAccount(), makeEnvelope(), raw)).resolves.toBeUndefined();

      expect(emitted).toHaveLength(1);
    });

    it('still stores the message when its raw form cannot be serialized', async () => {
      const { pipeline, insertInbound } = setup({ toStorableRaw: () => { throw new Error('bad raw'); } });

      await pipeline.handle(makeAccount(), makeEnvelope(), raw);

      expect(insertInbound).toHaveBeenCalledWith(expect.anything(), undefined);
    });
  });

  describe('replayFailed', () => {
    it('stores what the failed log holds, without emitting it again', async () => {
      const { pipeline, insertInbound, emitted, failedLog } = setup();
      const envelope = makeEnvelope({ id: 'kept' });
      vi.mocked(failedLog.replay).mockImplementation(async (save) => {
        await save({ envelope, raw: { stored: true } });
        return { saved: 1, kept: 0 };
      });

      await pipeline.replayFailed();

      expect(insertInbound).toHaveBeenCalledWith(envelope, { stored: true });
      expect(emitted).toEqual([]);
    });

    async function replayOne(context: ReturnType<typeof setup>, envelope: UnifiedEnvelope): Promise<void> {
      vi.mocked(context.failedLog.replay).mockImplementation(async (save) => {
        await save({ envelope, raw: {} });
        return { saved: 1, kept: 0 };
      });
      await context.pipeline.replayFailed();
    }

    function capturingWarnings() {
      const warn = vi.fn();
      const fake = { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn(), child: () => fake };
      setGlobalLogger(fake as unknown as Logger);
      return warn;
    }

    afterEach(() => setGlobalLogger(originalLogger));

    it('does not store a conversation the account excludes today, and says so', async () => {
      const warn = capturingWarnings();
      const context = setup({ account: makeAccount({ conversations: ['34600999999@s.whatsapp.net'] }) });

      await replayOne(context, makeEnvelope({ id: 'excluded' }));

      expect(context.insertInbound).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ messageId: 'excluded' }));
    });

    it('does not store a message of an account that no longer exists', async () => {
      const warn = capturingWarnings();
      const context = setup({ account: undefined });

      await replayOne(context, makeEnvelope({ id: 'orphan' }));

      expect(context.insertInbound).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ messageId: 'orphan' }));
    });

    it('does not store a LID it cannot resolve for an account with a list', async () => {
      const warn = capturingWarnings();
      const context = setup({
        account: makeAccount({ conversations: ['34600111222@s.whatsapp.net'] }),
        resolveLidToPhone: async () => undefined,
      });

      await replayOne(context, makeEnvelope({ id: 'unresolved', conversationId: '100000000000001@lid' }));

      expect(context.insertInbound).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ messageId: 'unresolved' }));
    });

    it('treats a resolver that fails as a LID it cannot resolve', async () => {
      capturingWarnings();
      const context = setup({
        account: makeAccount({ conversations: ['34600111222@s.whatsapp.net'] }),
        resolveLidToPhone: async () => { throw new Error('no socket'); },
      });

      await replayOne(context, makeEnvelope({ conversationId: '100000000000001@lid' }));

      expect(context.insertInbound).not.toHaveBeenCalled();
    });

    it('judges a LID it can resolve by its phone, and stores it under that conversation', async () => {
      const allowed = setup({
        account: makeAccount({ conversations: ['34600111222@s.whatsapp.net'] }),
        resolveLidToPhone: async () => '34600111222:5@s.whatsapp.net',
      });
      await replayOne(allowed, makeEnvelope({ conversationId: '100000000000001@lid' }));
      expect(allowed.insertInbound).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: '34600111222@s.whatsapp.net' }), {},
      );

      capturingWarnings();
      const excluded = setup({
        account: makeAccount({ conversations: ['34600999999@s.whatsapp.net'] }),
        resolveLidToPhone: async () => '34600111222:5@s.whatsapp.net',
      });
      await replayOne(excluded, makeEnvelope({ conversationId: '100000000000001@lid' }));
      expect(excluded.insertInbound).not.toHaveBeenCalled();
    });

    it('stores a LID as it is when the account has no list: there is nothing to judge', async () => {
      const context = setup({ account: makeAccount(), resolveLidToPhone: async () => undefined });

      await replayOne(context, makeEnvelope({ conversationId: '100000000000001@lid' }));

      expect(context.insertInbound).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: '100000000000001@lid' }), {},
      );
    });

    it('does nothing when storage is disabled', async () => {
      const { pipeline, failedLog } = setup({ insert: null });

      await pipeline.replayFailed();

      expect(failedLog.replay).not.toHaveBeenCalled();
    });
  });

  describe('drain', () => {
    it('waits for the queue when the store is healthy', async () => {
      const { pipeline, insertInbound, failedLog } = setup();

      void pipeline.handle(makeAccount(), makeEnvelope({ id: 'm1' }), raw);
      void pipeline.handle(makeAccount(), makeEnvelope({ id: 'm2' }), raw);
      await pipeline.drain(1_000);

      expect(insertInbound).toHaveBeenCalledTimes(2);
      expect(failedLog.append).not.toHaveBeenCalled();
    });

    it('stops waiting between retries: a failing message gets one more attempt and goes to the failed log', async () => {
      const { pipeline, insertInbound, failedLog } = setup({ insert: new Error('db down'), persistRetryDelaysMs: [60_000, 60_000] });

      const running = pipeline.handle(makeAccount(), makeEnvelope({ id: 'm1' }), raw);
      await new Promise((r) => setImmediate(r));
      expect(insertInbound).toHaveBeenCalledTimes(1);

      await pipeline.drain(1_000);
      await running;

      expect(insertInbound).toHaveBeenCalledTimes(2);
      expect(failedLog.append).toHaveBeenCalledTimes(1);
    });

    it('at the deadline writes off everything still unsaved, once each, media marked pending and raw in storable form', async () => {
      const { pipeline, insertInbound, failedLog, media } = setup({ toStorableRaw: () => ({ stored: true }) });
      insertInbound.mockImplementation(() => new Promise(() => {})); // a store that hangs
      const image = makeImageEnvelope();
      image.id = 'queued-image';

      void pipeline.handle(makeAccount(), makeEnvelope({ id: 'in-flight' }), raw);
      void pipeline.handle(makeAccount(), image, raw);
      void pipeline.handle(makeAccount({ id: 'wa-2', conversations: ['other@g.us'] }), makeEnvelope({ id: 'filtered', accountId: 'wa-2' }), raw);
      await new Promise((r) => setImmediate(r));

      await pipeline.drain(10);

      const appended = vi.mocked(failedLog.append).mock.calls.map(([entry]) => entry);
      expect(appended.map((entry) => entry.envelope.id)).toEqual(['in-flight', 'queued-image']);
      expect(appended.every((entry) => (entry.raw as { stored: boolean }).stored)).toBe(true);
      expect((appended[1]!.envelope.content as { media: Record<string, unknown> }).media).toMatchObject({ status: 'pending' });
      expect((appended[1]!.envelope.content as { media: Record<string, unknown> }).media).not.toHaveProperty('base64');
      expect(media.process).not.toHaveBeenCalled();
    });
  });

  it('emits directly when storage disabled', async () => {
    const { pipeline, emitted, metrics } = setup({ insert: null });

    await pipeline.handle(makeAccount(), makeEnvelope(), raw);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].seq).toBeUndefined();
    expect(metrics.persistFailures).not.toHaveBeenCalled();
  });

  it('passes the storable form of the raw message to insertInbound', async () => {
    const toStorableRaw = vi.fn(() => ({ stored: true }));
    const { pipeline, insertInbound, media } = setup({ toStorableRaw });
    const msg = { key: { id: 'WAID1' } };

    await pipeline.handle(makeAccount(), makeImageEnvelope(), msg);

    expect(toStorableRaw).toHaveBeenCalledWith(msg);
    expect(insertInbound).toHaveBeenCalledWith(expect.anything(), { stored: true });
    expect(media.process).toHaveBeenCalledWith(expect.anything(), msg); // media gets the untouched message
  });

  it('passes the raw message through unchanged when no serializer is injected', async () => {
    const { pipeline, insertInbound } = setup();
    const msg = { key: { id: 'WAID1' } };

    await pipeline.handle(makeAccount(), makeEnvelope(), msg);

    expect(insertInbound).toHaveBeenCalledWith(expect.anything(), msg);
  });

  it('schedules media after emit', async () => {
    const { pipeline, emitSpy, media } = setup();
    const envelope = makeImageEnvelope();

    await pipeline.handle(makeAccount(), envelope, raw);

    expect(media.process).toHaveBeenCalledWith(envelope, raw);
    expect(emitSpy.mock.invocationCallOrder[0]).toBeLessThan((media.process as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]);
  });

  it('marks media as pending and never carries base64 on inbound', async () => {
    const { pipeline, insertInbound, emitted } = setup();

    await pipeline.handle(makeAccount(), makeImageEnvelope(), raw);

    const stored = (insertInbound.mock.calls[0] as unknown as [UnifiedEnvelope])[0];
    const media = (stored.content as { media: Record<string, unknown> }).media;
    expect(media.status).toBe('pending');
    expect(media).not.toHaveProperty('base64');
    expect((emitted[0].content as { media: Record<string, unknown> }).media.status).toBe('pending');
  });

  it('does not schedule media for messages without media', async () => {
    const { pipeline, media } = setup();

    await pipeline.handle(makeAccount(), makeEnvelope(), raw);

    expect(media.process).not.toHaveBeenCalled();
  });

  it('does not wait for a slow event handler to store the next message, and starts handlers in order', async () => {
    const eventBus = new EventBus();
    const started: string[] = [];
    let finishHandler!: () => void;
    const handlerDone = new Promise<void>((resolve) => { finishHandler = resolve; });
    eventBus.on<MessageInboundPayload>(Events.MESSAGE_INBOUND, (e) => {
      started.push(e.data.envelope.id);
      return handlerDone; // a webhook that hangs
    });
    let next = 0;
    const insertInbound = vi.fn(async (): Promise<InsertResult> => ({ inserted: true, seq: ++next, accountSeq: next }));
    const pipeline = new InboundPipeline({
      store: { insertInbound } as unknown as MessageLogPort,
      eventBus,
      media: { process: vi.fn(async () => {}), resumePendingMedia: vi.fn(async () => 0) },
      metrics: noopMetrics,
    });

    await pipeline.handle(makeAccount(), makeEnvelope({ id: 'm1' }), raw);
    await pipeline.handle(makeAccount(), makeEnvelope({ id: 'm2' }), raw);

    expect(insertInbound).toHaveBeenCalledTimes(2);
    expect(started).toEqual(['m1', 'm2']);
    finishHandler();
  });

  it('still schedules media when storage is disabled or insert fails', async () => {
    for (const insert of [null, new Error('boom')]) {
      const { pipeline, media } = setup({ insert });
      await pipeline.handle(makeAccount(), makeImageEnvelope(), raw);
      expect(media.process).toHaveBeenCalledTimes(1);
    }
  });

  it('does not let a failing media job break the pipeline', async () => {
    const { pipeline, media } = setup();
    (media.process as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('disk full'));

    await expect(pipeline.handle(makeAccount(), makeImageEnvelope(), raw)).resolves.toBeUndefined();
  });

  describe('enrichment', () => {
    it('runs inside the queue: the turn is taken when handle() is called, not when enrichment ends', async () => {
      const { pipeline, insertInbound } = setup();
      let release = () => {};
      const slow = new Promise<void>((resolve) => { release = resolve; });

      const first = pipeline.handle(makeAccount(), makeEnvelope({ id: 'first' }), {}, () => slow);
      const second = pipeline.handle(makeAccount(), makeEnvelope({ id: 'second' }), {});
      await new Promise((resolve) => setImmediate(resolve));
      expect(insertInbound).not.toHaveBeenCalled();

      release();
      await Promise.all([first, second]);

      expect(insertInbound.mock.calls.map(([envelope]) => (envelope as UnifiedEnvelope).id)).toEqual(['first', 'second']);
    });

    it('applies the conversation filter to what enrichment resolved', async () => {
      const { pipeline, insertInbound } = setup();
      const account = makeAccount({ conversations: ['34600111222@s.whatsapp.net'] });
      const envelope = makeEnvelope({ conversationId: '100000000000001@lid' });

      await pipeline.handle(account, envelope, {}, async () => { envelope.conversationId = '34600111222@s.whatsapp.net'; });

      expect(insertInbound).toHaveBeenCalledTimes(1);
    });

    it('stores the message anyway when enrichment fails', async () => {
      const { pipeline, insertInbound } = setup();

      await pipeline.handle(makeAccount(), makeEnvelope(), {}, async () => { throw new Error('no socket'); });

      expect(insertInbound).toHaveBeenCalledTimes(1);
    });

    it('a shutdown keeps a message it could not enrich only when its conversation is an unresolved LID', async () => {
      const { pipeline, failedLog } = setup();
      const account = makeAccount({ conversations: ['34600111222@s.whatsapp.net'] });

      void pipeline.handle(account, makeEnvelope({ conversationId: '100000000000001@lid' }), {}, () => new Promise(() => {}));
      await pipeline.drain(10);

      expect(failedLog.append).toHaveBeenCalledTimes(1);
    });

    it('a shutdown applies the filter to a message not enriched yet whose conversation can be judged', async () => {
      const { pipeline, failedLog } = setup();
      const account = makeAccount({ conversations: ['34600111222@s.whatsapp.net'] });

      void pipeline.handle(account, makeEnvelope({ conversationId: '120363000000000009@g.us' }), {}, () => new Promise(() => {}));
      await pipeline.drain(10);

      expect(failedLog.append).not.toHaveBeenCalled();
    });

    it('an enrichment that fails leaves an unresolved LID out of a filtered account, as in the live path', async () => {
      const { pipeline, insertInbound } = setup();
      const account = makeAccount({ conversations: ['34600111222@s.whatsapp.net'] });

      await pipeline.handle(account, makeEnvelope({ conversationId: '100000000000001@lid' }), {}, async () => { throw new Error('no socket'); });

      expect(insertInbound).not.toHaveBeenCalled();
    });
  });

  describe('per-account ordering', () => {
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

    /** Store whose insert latency depends on the message; seq follows the order inserts START. */
    function slowStore(latency: Record<string, number>) {
      let next = 0;
      const insertInbound = vi.fn(async (envelope: UnifiedEnvelope): Promise<InsertResult> => {
        const seq = ++next;
        await delay(latency[envelope.id] ?? 0);
        return { inserted: true, seq, accountSeq: seq };
      });
      return { insertInbound, store: { insertInbound } as unknown as MessageLogPort };
    }

    function build(store: MessageLogPort) {
      const eventBus = new EventBus();
      const order: string[] = [];
      eventBus.on<MessageInboundPayload>(Events.MESSAGE_INBOUND, (e) => {
        order.push(`${e.data.envelope.id}:${e.data.envelope.accountSeq}`);
      });
      const pipeline = new InboundPipeline({
        store, eventBus,
        media: { process: vi.fn(async () => {}), resumePendingMedia: vi.fn(async () => 0) },
        metrics: { incCounter: vi.fn(), decGauge: vi.fn(), incGauge: vi.fn(), observeHistogram: vi.fn(), persistFailures: vi.fn(), mediaSkipped: vi.fn(), inboundSkipped: vi.fn(), lastInbound: vi.fn() },
      });
      return { pipeline, order };
    }

    it('emits messages of the same account in accountSeq order even when the first insert is slower', async () => {
      const { store } = slowStore({ m1: 40, m2: 0 });
      const { pipeline, order } = build(store);
      const account = makeAccount();

      await Promise.all([
        pipeline.handle(account, makeEnvelope({ id: 'm1' }), raw),
        pipeline.handle(account, makeEnvelope({ id: 'm2' }), raw),
      ]);

      expect(order).toEqual(['m1:1', 'm2:2']);
    });

    it('does not start the next insert before the previous insert has finished', async () => {
      const { store, insertInbound } = slowStore({ m1: 20 });
      const { pipeline } = build(store);
      const account = makeAccount();

      const first = pipeline.handle(account, makeEnvelope({ id: 'm1' }), raw);
      const second = pipeline.handle(account, makeEnvelope({ id: 'm2' }), raw);
      await delay(5);
      expect(insertInbound).toHaveBeenCalledTimes(1);
      await Promise.all([first, second]);
      expect(insertInbound).toHaveBeenCalledTimes(2);
    });

    it('keeps processing after a message fails, and still rejects that call', async () => {
      const { store, insertInbound } = slowStore({});
      const { pipeline, order } = build(store);
      const account = makeAccount();
      const failing = makeEnvelope({ id: 'bad' });
      Object.defineProperty(failing, 'sender', { get: () => { throw new Error('boom'); } });

      const results = await Promise.allSettled([
        pipeline.handle(account, failing, raw),
        pipeline.handle(account, makeEnvelope({ id: 'ok' }), raw),
      ]);

      expect(results[0].status).toBe('rejected');
      expect(results[1].status).toBe('fulfilled');
      expect(order).toEqual(['ok:1']);
      expect(insertInbound).toHaveBeenCalledTimes(1);
    });

    it('does not make different accounts wait for each other', async () => {
      const { store } = slowStore({ a1: 60 });
      const { pipeline, order } = build(store);

      await Promise.all([
        pipeline.handle(makeAccount({ id: 'A' }), makeEnvelope({ id: 'a1', accountId: 'A' }), raw),
        pipeline.handle(makeAccount({ id: 'B' }), makeEnvelope({ id: 'b1', accountId: 'B' }), raw),
      ]);

      expect(order.map((o) => o.split(':')[0])).toEqual(['b1', 'a1']);
    });
  });

  describe('LID resolution', () => {
    const lidEnvelope = () => makeEnvelope({ sender: { id: '144980999962625@lid', lid: '144980999962625@lid' } });

    it('resolves sender.phone from sender.lid before inserting', async () => {
      const resolveLidToPhone = vi.fn(async () => '34600111222:0@s.whatsapp.net');
      const { pipeline, insertInbound } = setup({ resolveLidToPhone });

      await pipeline.handle(makeAccount(), lidEnvelope(), raw);

      expect(resolveLidToPhone).toHaveBeenCalledWith('wa-1', '144980999962625@lid');
      const stored = (insertInbound.mock.calls[0] as unknown as [UnifiedEnvelope])[0];
      expect(stored.sender.phone).toBe('+34600111222');
    });

    it('leaves phone unset when the lid cannot be resolved or the resolver fails', async () => {
      for (const resolveLidToPhone of [vi.fn(async () => undefined), vi.fn(async () => { throw new Error('x'); })]) {
        const { pipeline, emitted } = setup({ resolveLidToPhone });
        await pipeline.handle(makeAccount(), lidEnvelope(), raw);
        expect(emitted).toHaveLength(1);
        expect(emitted[0].sender.phone).toBeUndefined();
      }
    });

    it('does not call the resolver when phone is already known or there is no lid', async () => {
      const resolveLidToPhone = vi.fn(async () => '1@s.whatsapp.net');
      const { pipeline } = setup({ resolveLidToPhone });

      await pipeline.handle(makeAccount(), makeEnvelope({ sender: { id: 'x', phone: '+34600111222', lid: 'y@lid' } }), raw);
      await pipeline.handle(makeAccount(), makeEnvelope({ sender: { id: 'x' } }), raw);

      expect(resolveLidToPhone).not.toHaveBeenCalled();
    });
  });
});
