/**
 * The failed log end to end: a store that keeps failing sends the message to the file through
 * the real pipeline, and the next start stores it in a real message log and empties the file.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermanentStoreError } from '../../../src/core/errors.js';
import { EventBus } from '../../../src/core/event-bus.js';
import { Events } from '../../../src/core/events.js';
import type { MessageInboundPayload } from '../../../src/core/events.js';
import { InboundPipeline } from '../../../src/core/inbound/inbound-pipeline.js';
import { noopMediaService } from '../../../src/core/inbound/media-service.js';
import { getLogger, setGlobalLogger, type Logger } from '../../../src/core/logger/logger.port.js';
import { noopMetrics } from '../../../src/core/metrics/metrics.port.js';
import type { ChannelAccount } from '../../../src/core/accounts/channel-account.js';
import type { FailedInboundLog } from '../../../src/core/inbound/failed-inbound-log.js';
import type { MessageLogPort } from '../../../src/core/persistence/message-store.port.js';
import type { UnifiedEnvelope } from '../../../src/core/messaging/unified-envelope.js';
import { FailedInboundFile } from '../../../src/persistence/failed-inbound-file.js';
import { SqliteMessageStore } from '../../../src/persistence/sqlite-message-store.js';

const account = { id: 'wa-1', provider: 'baileys' } as ChannelAccount;
const knownAccount = { findById: async () => account };

function envelope(id: string, waId: string, content: UnifiedEnvelope['content'] = { type: 'text', body: 'hola' }): UnifiedEnvelope {
  const when = new Date('2026-05-01T10:00:00.000Z');
  return {
    id,
    accountId: 'wa-1',
    channel: 'whatsapp',
    direction: 'inbound',
    timestamp: when,
    sentAt: when,
    conversationId: 'c@s.whatsapp.net',
    sender: { id: 's@s.whatsapp.net' },
    recipient: { id: '+34600000001' },
    content,
    channelDetails: { platform: 'whatsapp', messageId: waId },
    gateway: { receivedAt: when, adapterId: 'baileys', account: { id: 'wa-1', alias: 'a', owner: 'o', tags: [] } },
  };
}

describe('FailedInboundFile', () => {
  let dir: string;
  let path: string;
  let file: FailedInboundFile;
  let store: SqliteMessageStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mg-failed-'));
    path = join(dir, 'nested', 'failed-inbound.jsonl');
    file = new FailedInboundFile(path);
    store = new SqliteMessageStore(':memory:');
    await store.init();
    await store.runMigrations();
  });

  afterEach(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });

  const pipelineOn = (log: Pick<MessageLogPort, 'insertInbound'>, accounts: { findById(id: string): Promise<ChannelAccount | undefined> } = knownAccount) => new InboundPipeline({
    store: log as MessageLogPort,
    failedLog: file,
    eventBus: new EventBus(),
    media: noopMediaService,
    metrics: noopMetrics,
    accounts,
    persistRetryDelaysMs: [],
  });

  it('an outage end to end: what arrives goes to the file, delivered live; when the store is back it all reaches the log, in order', async () => {
    let down = true;
    const flaky = {
      insertInbound: async (e: UnifiedEnvelope, r?: unknown) => {
        if (down) throw new Error('db down');
        return store.insertInbound(e, r);
      },
      probeWrite: async () => {
        if (down) throw new Error('db down');
      },
    };
    const emitted: Array<number | undefined> = [];
    const bus = new EventBus();
    bus.on<MessageInboundPayload>(Events.MESSAGE_INBOUND, (event) => { emitted.push(event.data.envelope.accountSeq); });
    const media = { process: vi.fn(async () => {}), resumePendingMedia: vi.fn(async () => 0) };
    const pipeline = new InboundPipeline({
      store: flaky as MessageLogPort, failedLog: file, eventBus: bus, media, metrics: noopMetrics, accounts: knownAccount,
      persistRetryDelaysMs: [], storeProbeIntervalMs: 5,
    });

    for (const n of [1, 2, 3]) await pipeline.handle(account, envelope(`m${n}`, `W${n}`), { n });
    expect(emitted).toEqual([undefined, undefined, undefined]);
    expect(await store.count({ accountId: 'wa-1' })).toBe(0);

    down = false;
    await vi.waitFor(() => expect(existsSync(path)).toBe(false));
    await vi.waitFor(() => expect(media.resumePendingMedia).toHaveBeenCalled()); // the recovery has ended
    await pipeline.handle(account, envelope('m4', 'W4'), { n: 4 });

    const page = await store.queryAfter({ accountId: 'wa-1', afterAccountSeq: 0, limit: 10 });
    expect(page.messages.map((m) => [m.id, m.accountSeq])).toEqual([['m1', 1], ['m2', 2], ['m3', 3], ['m4', 4]]);
    expect(emitted).toEqual([undefined, undefined, undefined, 4]);
    await pipeline.drain(10);
  });

  describe('accountSeq keeps the order of arrival across an outage', () => {
    /** A message log that fails while `down`, and holds the save of an id for as long as the test says. */
    function outageRig(failedLog: FailedInboundLog = file) {
      const rig = {
        down: true,
        holds: new Map<string, Promise<void>>(),
        emitted: [] as Array<[string, number | undefined]>,
        pipeline: undefined as unknown as InboundPipeline,
        /** Called when a recovery that stored something has ended. */
        media: { process: vi.fn(async () => {}), resumePendingMedia: vi.fn(async () => 0) },
        numbers: async () => (await store.queryAfter({ accountId: 'wa-1', afterAccountSeq: 0, limit: 20 })).messages.map((m) => [m.id, m.accountSeq]),
      };
      const log = {
        insertInbound: async (e: UnifiedEnvelope, r?: unknown) => {
          await rig.holds.get(e.id);
          if (rig.down) throw new Error('db down');
          return store.insertInbound(e, r);
        },
        probeWrite: async () => {
          if (rig.down) throw new Error('db down');
        },
      };
      const bus = new EventBus();
      bus.on<MessageInboundPayload>(Events.MESSAGE_INBOUND, (event) => { rig.emitted.push([event.data.envelope.id, event.data.envelope.accountSeq]); });
      rig.pipeline = new InboundPipeline({
        store: log as MessageLogPort, failedLog, eventBus: bus, media: rig.media, metrics: noopMetrics, accounts: knownAccount,
        persistRetryDelaysMs: [], storeProbeIntervalMs: 5,
      });
      return rig;
    }

    const gate = () => {
      let open = () => {};
      const opened = new Promise<void>((resolve) => { open = resolve; });
      return { opened, open };
    };

    afterEach(() => vi.useRealTimers());

    it('what arrives while the log is replayed goes behind it, delivered live, and only then messages are stored directly', async () => {
      const rig = outageRig();
      await rig.pipeline.handle(account, envelope('m1', 'W1'), {});
      await rig.pipeline.handle(account, envelope('m2', 'W2'), {});

      const replaying = gate();
      const reached = vi.fn();
      rig.holds.set('m1', replaying.opened.then(reached));
      rig.down = false;
      await vi.waitFor(async () => expect(await readFile(path, 'utf8')).toContain('m1'));
      await new Promise((resolve) => setTimeout(resolve, 30)); // the probe wrote, and the pass is held at m1
      await rig.pipeline.handle(account, envelope('during', 'W3'), {});
      expect(await rig.numbers()).toEqual([]);

      replaying.open();
      await vi.waitFor(() => expect(rig.media.resumePendingMedia).toHaveBeenCalledTimes(1));
      expect(existsSync(path)).toBe(false);
      await rig.pipeline.handle(account, envelope('after', 'W4'), {});

      expect(await rig.numbers()).toEqual([['m1', 1], ['m2', 2], ['during', 3], ['after', 4]]);
      expect(rig.emitted).toEqual([['m1', undefined], ['m2', undefined], ['during', undefined], ['after', 4]]);
      await rig.pipeline.drain(10);
    });

    it('holds with a cut that starts again during the recovery', async () => {
      const rig = outageRig();
      for (const id of ['m1', 'm2', 'm3']) await rig.pipeline.handle(account, envelope(id, `W-${id}`), {});

      const atSecond = gate();
      rig.holds.set('m2', atSecond.opened);
      rig.down = false;
      await vi.waitFor(async () => expect((await rig.numbers()).map(([id]) => id)).toEqual(['m1']));
      rig.down = true;
      atSecond.open();
      rig.holds.delete('m2');
      await vi.waitFor(async () => expect(JSON.parse((await readFile(path, 'utf8')).split('\n')[0]!).envelope.id).toBe('m2'));

      await rig.pipeline.handle(account, envelope('during-cut', 'W5'), {});
      expect(await rig.numbers()).toEqual([['m1', 1]]);

      rig.down = false;
      await vi.waitFor(() => expect(rig.media.resumePendingMedia).toHaveBeenCalledTimes(2));
      expect(existsSync(path)).toBe(false);
      await rig.pipeline.handle(account, envelope('after', 'W6'), {});

      expect(await rig.numbers()).toEqual([['m1', 1], ['m2', 2], ['m3', 3], ['during-cut', 4], ['after', 5]]);
      await rig.pipeline.drain(10);
    });

    it('a message still being written when the recovery ends is stored before the next of its account, whatever the state says by then', async () => {
      const writing = gate();
      const slowFile: FailedInboundLog = {
        append: async (entry) => {
          if (entry.envelope.id === 'late') await writing.opened;
          await file.append(entry);
        },
        replay: (save) => file.replay(save),
      };
      const rig = outageRig(slowFile);
      await rig.pipeline.handle(account, envelope('m1', 'W1'), {});

      const replaying = gate();
      rig.holds.set('m1', replaying.opened);
      rig.down = false;
      await new Promise((resolve) => setTimeout(resolve, 30)); // the probe wrote, and the pass is held at m1
      const late = rig.pipeline.handle(account, envelope('late', 'W2'), {});
      await new Promise((resolve) => setImmediate(resolve));
      replaying.open();
      await vi.waitFor(() => expect(rig.media.resumePendingMedia).toHaveBeenCalledTimes(1)); // it found nothing else, and ended

      const next = rig.pipeline.handle(account, envelope('next', 'W3'), {});
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await rig.numbers()).toEqual([['m1', 1]]);

      writing.open();
      await Promise.all([late, next]);

      expect(await rig.numbers()).toEqual([['m1', 1], ['late', 2], ['next', 3]]);
      expect(rig.emitted).toEqual([['m1', undefined], ['late', undefined], ['next', 3]]);
      expect(existsSync(path)).toBe(false);
      await rig.pipeline.drain(10);
    });

    it('a LID waiting does not hold the recovery: it stays, and messages are stored directly', async () => {
      const withList = { ...account, conversations: ['c@s.whatsapp.net'] } as ChannelAccount;
      const log = { insertInbound: async (e: UnifiedEnvelope, r?: unknown) => store.insertInbound(e, r), probeWrite: async () => {} };
      const media = { process: vi.fn(async () => {}), resumePendingMedia: vi.fn(async () => 0) };
      const pipeline = new InboundPipeline({
        store: log as MessageLogPort, failedLog: file, eventBus: new EventBus(), media, metrics: noopMetrics,
        accounts: { findById: async () => withList }, persistRetryDelaysMs: [], storeProbeIntervalMs: 1,
      });
      await file.append({ envelope: { ...envelope('lid', 'W1'), accountId: 'wa-2', conversationId: '1@lid' }, raw: undefined });
      const failing = vi.spyOn(log, 'insertInbound').mockRejectedValueOnce(new Error('blip'));

      await pipeline.handle(withList, envelope('opener', 'W2'), {});
      await vi.waitFor(() => expect(media.resumePendingMedia).toHaveBeenCalledTimes(1));
      failing.mockRestore();
      await pipeline.handle(withList, envelope('after', 'W3'), {});

      expect((await store.queryAfter({ accountId: 'wa-1', afterAccountSeq: 0, limit: 10 })).messages.map((m) => [m.id, m.accountSeq])).toEqual([['opener', 1], ['after', 2]]);
      expect((await readFile(path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line).envelope.id)).toEqual(['lid']);
      await pipeline.drain(10);
    });

    it('what its account has behind a waiting LID stays behind it, the other accounts go on, and the recovery still closes', async () => {
      const phone = '34600111222@s.whatsapp.net';
      const withList = { ...account, conversations: [phone] } as ChannelAccount;
      const other = { ...account, id: 'wa-2' } as ChannelAccount;
      const of = (accountId: string, id: string, conversationId = phone) => ({
        ...envelope(id, `W-${id}`), accountId, conversationId,
      });
      const log = { insertInbound: async (e: UnifiedEnvelope, r?: unknown) => store.insertInbound(e, r), probeWrite: async () => {} };
      const media = { process: vi.fn(async () => {}), resumePendingMedia: vi.fn(async () => 0) };
      let resolvable = false;
      const pipeline = new InboundPipeline({
        store: log as MessageLogPort, failedLog: file, eventBus: new EventBus(), media, metrics: noopMetrics,
        accounts: { findById: async (id: string) => (id === 'wa-1' ? withList : other) },
        resolveLidToPhone: async () => (resolvable ? phone : undefined),
        persistRetryDelaysMs: [], storeProbeIntervalMs: 1,
      });
      await file.append({ envelope: of('wa-1', 'lid', '1@lid'), raw: undefined });
      await file.append({ envelope: of('wa-1', 'behind'), raw: undefined });
      await file.append({ envelope: of('wa-2', 'other'), raw: undefined });
      const failing = vi.spyOn(log, 'insertInbound').mockRejectedValueOnce(new Error('blip'));

      await pipeline.handle(other, of('wa-2', 'opener'), {});
      await vi.waitFor(() => expect(media.resumePendingMedia).toHaveBeenCalledTimes(1));
      failing.mockRestore();

      const fileIds = async () => (await readFile(path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line).envelope.id);
      const numbers = async (accountId: string) => (await store.queryAfter({ accountId, afterAccountSeq: 0, limit: 10 })).messages.map((m) => [m.id, m.accountSeq]);
      expect(await fileIds()).toEqual(['lid', 'behind']);
      expect(await numbers('wa-1')).toEqual([]);

      // Closed: both accounts store directly.
      await pipeline.handle(other, of('wa-2', 'after'), {});
      expect(await numbers('wa-2')).toEqual([['other', 1], ['opener', 2], ['after', 3]]);

      resolvable = true;
      await pipeline.replayFailed();
      expect(await numbers('wa-1')).toEqual([['lid', 1], ['behind', 2]]);
      expect(existsSync(path)).toBe(false);
      await pipeline.drain(10);
    });

    it('an account that cannot be looked up holds back what it has behind too, and nothing else', async () => {
      const other = { ...account, id: 'wa-2' } as ChannelAccount;
      const pipeline = new InboundPipeline({
        store, failedLog: file, eventBus: new EventBus(), media: noopMediaService, metrics: noopMetrics,
        accounts: { findById: async (id: string) => {
          if (id === 'wa-1') throw new Error('repo down');
          return other;
        } },
        persistRetryDelaysMs: [],
      });
      await file.append({ envelope: envelope('first', 'W1'), raw: undefined });
      await file.append({ envelope: { ...envelope('elsewhere', 'W2'), accountId: 'wa-2' }, raw: undefined });

      await pipeline.replayFailed();

      expect((await readFile(path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line).envelope.id)).toEqual(['first']);
      await pipeline.drain(10);
    });
  });

  describe('a recovery that fails', () => {
    const rejectedPath = () => join(dir, 'nested', 'failed-inbound.rejected.jsonl');
    const fileIds = async () => (await readFile(path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line).envelope.id as string);
    const storedIds = async (accountId = 'wa-1') => (await store.queryAfter({ accountId, afterAccountSeq: 0, limit: 20 })).messages.map((m) => [m.id, m.accountSeq]);
    const other = { ...account, id: 'wa-2' } as ChannelAccount;
    const ofOther = (id: string) => ({ ...envelope(id, `W-${id}`), accountId: 'wa-2' });

    const media = { process: vi.fn(async () => {}), resumePendingMedia: vi.fn(async () => 0) };

    beforeEach(() => media.resumePendingMedia.mockClear());

    function pipelineOver(log: Pick<MessageLogPort, 'insertInbound' | 'probeWrite'>) {
      return new InboundPipeline({
        store: log as MessageLogPort, failedLog: file, eventBus: new EventBus(), media, metrics: noopMetrics,
        accounts: { findById: async (id: string) => (id === 'wa-2' ? other : account) },
        persistRetryDelaysMs: [0], storeProbeIntervalMs: 1,
      });
    }

    it('a database that answers SELECT 1 and refuses writes, for many cycles: the circuit stays open, nothing is rejected, and it all gets in when it is back', async () => {
      const db = (store as unknown as { db: import('better-sqlite3').Database }).db;
      db.pragma('query_only = ON');
      const probeWrite = vi.spyOn(store, 'probeWrite');
      const insertInbound = vi.spyOn(store, 'insertInbound');
      const pipeline = pipelineOver(store);

      await pipeline.handle(account, envelope('m1', 'W1'), {});
      await pipeline.handle(account, envelope('m2', 'W2'), {});
      insertInbound.mockClear();
      await vi.waitFor(() => expect(probeWrite.mock.calls.length).toBeGreaterThan(30));

      expect(await store.count({ accountId: 'wa-1' })).toBe(0); // it does answer reads
      expect(insertInbound).not.toHaveBeenCalled();
      expect(existsSync(rejectedPath())).toBe(false);
      expect(await fileIds()).toEqual(['m1', 'm2']);

      db.pragma('query_only = OFF');
      await vi.waitFor(() => expect(media.resumePendingMedia).toHaveBeenCalled());
      expect(await storedIds()).toEqual([['m1', 1], ['m2', 2]]);
      await pipeline.drain(10);
    });

    it('a store that also fails the probe right after the failed insert reopens the circuit, for many cycles, and nothing is rejected', async () => {
      await file.append({ envelope: envelope('m1', 'W1'), raw: undefined });
      const attempts: string[] = [];
      let justFailed = false;
      const pipeline = pipelineOver({
        insertInbound: async (e: UnifiedEnvelope) => {
          attempts.push(e.id);
          justFailed = true;
          throw new Error('could not write');
        },
        probeWrite: async () => {
          if (!justFailed) return;
          justFailed = false;
          throw new Error('could not write either');
        },
      });

      await pipeline.handle(account, envelope('opener', 'W0'), {});
      await vi.waitFor(() => expect(attempts.filter((id) => id === 'm1').length).toBeGreaterThan(12));

      expect(existsSync(rejectedPath())).toBe(false);
      await pipeline.drain(10);
      expect(await fileIds()).toEqual(['m1', 'opener']);
    });

    it('a failure only in messages, with the probe fine, for many cycles: nothing is rejected, nothing is lost, and it all gets in when it passes', async () => {
      let failing = true;
      const attempts: string[] = [];
      const pipeline = pipelineOver({
        insertInbound: async (e: UnifiedEnvelope, r?: unknown) => {
          attempts.push(e.id);
          if (failing) throw new Error('canceling statement due to lock timeout');
          return store.insertInbound(e, r);
        },
        probeWrite: () => store.probeWrite(),
      });

      for (let cycle = 0; cycle < 12; cycle++) {
        await pipeline.handle(account, envelope(`m${cycle}`, `W${cycle}`), {});
        // Its two live attempts opened the circuit; the pass that closes it tries the head, and holds back the rest.
        expect(attempts.filter((id) => id === `m${cycle}`).length).toBeGreaterThanOrEqual(2);
        await vi.waitFor(() => expect(attempts.filter((id) => id === 'm0').length).toBe(cycle + 3));
      }

      expect(existsSync(rejectedPath())).toBe(false);
      expect(await store.count({ accountId: 'wa-1' })).toBe(0);
      expect((await fileIds()).length).toBe(12);

      failing = false;
      await pipeline.replayFailed();
      expect((await storedIds()).map(([id]) => id)).toEqual(Array.from({ length: 12 }, (_, i) => `m${i}`));
      expect(existsSync(path)).toBe(false);
      await pipeline.drain(10);
    });

    it('a deterministic TypeError stays in the file with what its account has behind it, logged, without holding the other accounts or leaving the circuit open', async () => {
      const error = vi.fn();
      const fake = { info: vi.fn(), warn: vi.fn(), error, debug: vi.fn(), child: () => fake };
      const originalLogger = getLogger();
      setGlobalLogger(fake as unknown as Logger);
      try {
        await file.append({ envelope: envelope('typed', 'W1'), raw: undefined });
        await file.append({ envelope: envelope('behind', 'W2'), raw: undefined });
        await file.append({ envelope: ofOther('other'), raw: undefined });
        const insertInbound = vi.fn(async (e: UnifiedEnvelope, r?: unknown) => {
          if (e.id === 'typed' || e.id === 'opener') {
            if (e.id === 'opener' && insertInbound.mock.calls.filter(([x]) => x.id === 'opener').length > 2) return store.insertInbound(e, r);
            throw new TypeError('Cannot read properties of null');
          }
          return store.insertInbound(e, r);
        });
        const pipeline = pipelineOver({ insertInbound, probeWrite: () => store.probeWrite() });

        await pipeline.handle(other, ofOther('opener'), {});
        await vi.waitFor(() => expect(media.resumePendingMedia).toHaveBeenCalled());

        expect(await fileIds()).toEqual(['typed', 'behind']);
        expect(existsSync(rejectedPath())).toBe(false);
        expect(await storedIds('wa-2')).toEqual([['other', 1], ['opener', 2]]);
        expect(error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ messageId: 'typed' }));

        // The circuit is closed: both accounts store directly, and what is live goes ahead of what is held.
        await pipeline.handle(other, ofOther('after-other'), {});
        await pipeline.handle(account, envelope('after', 'W3'), {});
        expect(await storedIds('wa-2')).toEqual([['other', 1], ['opener', 2], ['after-other', 3]]);
        expect(await storedIds()).toEqual([['after', 1]]);
        await pipeline.drain(10);
      } finally {
        setGlobalLogger(originalLogger);
      }
    });

    it('only what is explicitly refused goes to the rejected log', async () => {
      await file.append({ envelope: envelope('refused', 'W1'), raw: undefined });
      await file.append({ envelope: envelope('ranged', 'W2'), raw: undefined });
      const pipeline = pipelineOver({
        insertInbound: async (e: UnifiedEnvelope) => {
          if (e.id === 'refused') throw new PermanentStoreError('value too long');
          throw new RangeError('Invalid time value');
        },
        probeWrite: () => store.probeWrite(),
      });

      await pipeline.replayFailed();

      expect(await fileIds()).toEqual(['ranged']);
      const rejected = (await readFile(rejectedPath(), 'utf8')).trim().split('\n').map((line) => JSON.parse(JSON.parse(line).line).envelope.id);
      expect(rejected).toEqual(['refused']);
      await pipeline.drain(10);
    });
  });

  it('a COMMIT whose answer was lost: the retry finds the row and the message goes out with its real number', async () => {
    let lost = true;
    const answerLost = {
      insertInbound: async (e: UnifiedEnvelope, r?: unknown) => {
        const result = await store.insertInbound(e, r);
        if (lost) {
          lost = false;
          throw new Error('Connection terminated unexpectedly');
        }
        return result;
      },
    };
    const emitted: Array<number | undefined> = [];
    const bus = new EventBus();
    bus.on<MessageInboundPayload>(Events.MESSAGE_INBOUND, (event) => { emitted.push(event.data.envelope.accountSeq); });
    const pipeline = new InboundPipeline({
      store: answerLost as MessageLogPort, failedLog: file, eventBus: bus, media: noopMediaService, metrics: noopMetrics, accounts: knownAccount,
      persistRetryDelaysMs: [0],
    });

    await pipeline.handle(account, envelope('m1', 'W1'), { n: 1 });

    expect(emitted).toEqual([1]);
    expect(existsSync(path)).toBe(false);
    expect(await store.maxAccountSeq('wa-1')).toBe(1);
  });

  it('what the filter or a missing account rejects at the next start is neither stored nor kept in the file', async () => {
    await file.append({ envelope: envelope('stays-out', 'W1'), raw: undefined });
    const withList = { ...account, conversations: ['other@s.whatsapp.net'] } as ChannelAccount;

    await pipelineOn(store, { findById: async () => withList }).replayFailed();

    expect(await store.count({ accountId: 'wa-1' })).toBe(0);
    expect(existsSync(path)).toBe(false);

    await file.append({ envelope: envelope('orphan', 'W2'), raw: undefined });
    await pipelineOn(store, { findById: async () => undefined }).replayFailed();

    expect(await store.count({ accountId: 'wa-1' })).toBe(0);
    expect(existsSync(path)).toBe(false);
  });

  it('keeps the entry when it cannot even look the account up: nothing was decided', async () => {
    await file.append({ envelope: envelope('m1', 'W1'), raw: undefined });

    await pipelineOn(store, { findById: async () => { throw new Error('repo down'); } }).replayFailed();

    expect(await store.count({ accountId: 'wa-1' })).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  it('a message the store refused reaches the log at the next start, with its sequence, and the file is emptied', async () => {
    const down = { insertInbound: vi.fn().mockRejectedValue(new Error('db down')) };
    await pipelineOn(down).handle(account, envelope('m1', 'W1'), { raw: 1 });
    await pipelineOn(down).handle(account, envelope('m2', 'W2'), { raw: 2 });
    expect(existsSync(path)).toBe(true);

    await pipelineOn(store).replayFailed();

    const page = await store.queryAfter({ accountId: 'wa-1', afterAccountSeq: 0, limit: 10 });
    expect(page.messages.map((m) => [m.id, m.accountSeq])).toEqual([['m1', 1], ['m2', 2]]);
    expect(page.messages[0]?.timestamp.toISOString()).toBe('2026-05-01T10:00:00.000Z');
    expect(page.messages[0]?.sentAt?.toISOString()).toBe('2026-05-01T10:00:00.000Z');
    expect((await store.findByWaMessageId('wa-1', 'W2'))?.raw).toEqual({ raw: 2 });
    expect(existsSync(path)).toBe(false);
  });

  it('is idempotent: replaying a message already stored does not store it again', async () => {
    const once = envelope('m1', 'W1');
    await store.insertInbound(once);
    await file.append({ envelope: once, raw: undefined });
    await file.append({ envelope: envelope('no-wa', ''), raw: undefined });
    await file.append({ envelope: envelope('no-wa', ''), raw: undefined });

    const result = await file.replay(async (entry) => { await store.insertInbound(entry.envelope, entry.raw); });

    expect(result).toEqual({ saved: 3, kept: 0, rejected: 0 });
    expect(await store.count({ accountId: 'wa-1' })).toBe(2);
    expect(await store.maxAccountSeq('wa-1')).toBe(2);
  });

  it('keeps what could not be stored and removes the rest, in order', async () => {
    await file.append({ envelope: envelope('ok-1', 'W1'), raw: undefined });
    await file.append({ envelope: envelope('bad', 'W2'), raw: undefined });
    await file.append({ envelope: envelope('ok-2', 'W3'), raw: undefined });
    const seen: string[] = [];

    const result = await file.replay(async ({ envelope: e }) => {
      seen.push(e.id);
      if (e.id === 'bad') throw new Error('still failing');
    });

    expect(seen).toEqual(['ok-1', 'bad', 'ok-2']);
    expect(result).toEqual({ saved: 2, kept: 1, rejected: 0 });
    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).envelope.id).toBe('bad');
  });

  it('leaves the file alone when nothing could be stored', async () => {
    await file.append({ envelope: envelope('bad', 'W1'), raw: undefined });
    const before = await readFile(path, 'utf8');

    const result = await file.replay(async () => { throw new Error('db down'); });

    expect(result).toEqual({ saved: 0, kept: 1, rejected: 0 });
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  describe('what can never get in', () => {
    const rejectedPath = () => join(dir, 'nested', 'failed-inbound.rejected.jsonl');
    const rejectedLines = async () => (await readFile(rejectedPath(), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { line: string; reason: string; rejectedAt: string });

    it('moves a line it cannot read to the rejected file, as it was, without losing the others', async () => {
      await file.append({ envelope: envelope('ok', 'W1'), raw: undefined });
      await writeFile(path, `${await readFile(path, 'utf8')}{"envelope":{"id":"trunc`);

      const result = await file.replay(async () => {});

      expect(result).toEqual({ saved: 1, kept: 0, rejected: 1 });
      expect(existsSync(path)).toBe(false);
      const [rejected] = await rejectedLines();
      expect(rejected?.line).toBe('{"envelope":{"id":"trunc');
      expect(rejected?.reason).toContain('cannot be read');
      expect(Number.isNaN(Date.parse(rejected?.rejectedAt ?? ''))).toBe(false);
    });

    it('treats as unreadable a line of valid JSON that is not an entry', async () => {
      await file.append({ envelope: envelope('ok', 'W1'), raw: undefined });
      await writeFile(path, `${await readFile(path, 'utf8')}{"foo":1}\n"text"\n`);

      const result = await file.replay(async () => {});

      expect(result).toEqual({ saved: 1, kept: 0, rejected: 2 });
      expect((await rejectedLines()).map((r) => r.line)).toEqual(['{"foo":1}', '"text"']);
    });

    it('moves what save refuses for good, says why, and keeps what may still pass', async () => {
      await file.append({ envelope: envelope('poison', 'W1'), raw: { n: 1 } });
      await file.append({ envelope: envelope('waiting', 'W2'), raw: undefined });
      await file.append({ envelope: envelope('fine', 'W3'), raw: undefined });

      const result = await file.replay(async ({ envelope: e }) => {
        if (e.id === 'poison') throw new PermanentStoreError('value too long');
        if (e.id === 'waiting') throw new Error('not yet');
      });

      expect(result).toEqual({ saved: 1, kept: 1, rejected: 1 });
      const lines = (await readFile(path, 'utf8')).trim().split('\n');
      expect(lines.map((line) => JSON.parse(line).envelope.id)).toEqual(['waiting']);
      const [rejected] = await rejectedLines();
      expect(rejected?.reason).toBe('value too long');
      expect(JSON.parse(rejected!.line)).toMatchObject({ envelope: { id: 'poison' }, raw: { n: 1 } });
    });

    it('never reads the rejected file back, and adds to what it holds', async () => {
      await file.append({ envelope: envelope('first', 'W1'), raw: undefined });
      const refuse = async () => { throw new PermanentStoreError('refused'); };
      await file.replay(refuse);

      const save = vi.fn(async () => {});
      expect(await file.replay(save)).toEqual({ saved: 0, kept: 0, rejected: 0 });
      expect(save).not.toHaveBeenCalled();

      await file.append({ envelope: envelope('second', 'W2'), raw: undefined });
      await file.replay(refuse);
      expect((await rejectedLines()).map((r) => JSON.parse(r.line).envelope.id)).toEqual(['first', 'second']);
    });

    it('leaves the entry where it is if the rejected file cannot be written, so nothing is lost', async () => {
      await file.append({ envelope: envelope('poison', 'W1'), raw: undefined });
      await mkdir(rejectedPath());

      await expect(file.replay(async () => { throw new PermanentStoreError('refused'); })).rejects.toThrow();

      expect(JSON.parse((await readFile(path, 'utf8')).trim()).envelope.id).toBe('poison');
    });

    it('through the pipeline: an entry the store refuses goes out, counted, and the rest reach the log', async () => {
      const refusing = {
        insertInbound: async (e: UnifiedEnvelope, r?: unknown) => {
          if (e.id === 'poison') throw new PermanentStoreError('value too long');
          return store.insertInbound(e, r);
        },
        probeWrite: async () => {},
      };
      await file.append({ envelope: envelope('poison', 'W1'), raw: undefined });
      await file.append({ envelope: envelope('fine', 'W2'), raw: undefined });
      const inboundRejected = vi.fn();
      const pipeline = new InboundPipeline({
        store: refusing as MessageLogPort, failedLog: file, eventBus: new EventBus(), media: noopMediaService,
        metrics: { ...noopMetrics, inboundRejected }, accounts: knownAccount, persistRetryDelaysMs: [],
      });

      expect(await pipeline.replayFailed()).toBe(1);

      expect(inboundRejected).toHaveBeenCalledWith(1);
      expect(existsSync(path)).toBe(false);
      expect((await store.queryAfter({ accountId: 'wa-1', afterAccountSeq: 0, limit: 10 })).messages.map((m) => m.id)).toEqual(['fine']);
    });
  });

  describe('a crash in the middle of an append', () => {
    const truncated = '{"envelope":{"id":"trunc';

    it('the next entry starts on a line of its own, so only the cut one is lost', async () => {
      await file.append({ envelope: envelope('first', 'W1'), raw: undefined });
      await writeFile(path, `${await readFile(path, 'utf8')}${truncated}`);

      await file.append({ envelope: envelope('after-crash', 'W2'), raw: undefined });

      const lines = (await readFile(path, 'utf8')).split('\n');
      expect(lines[1]).toBe(truncated);
      expect(JSON.parse(lines[2]!).envelope.id).toBe('after-crash');
      const seen: string[] = [];
      expect(await file.replay(async ({ envelope: e }) => { seen.push(e.id); })).toEqual({ saved: 2, kept: 0, rejected: 1 });
      expect(seen).toEqual(['first', 'after-crash']);
    });

    it('adds no empty line to a file that ends as it should', async () => {
      await file.append({ envelope: envelope('a', 'W1'), raw: undefined });
      await file.append({ envelope: envelope('b', 'W2'), raw: undefined });

      expect((await readFile(path, 'utf8')).split('\n').map((line) => line.length > 0)).toEqual([true, true, false]);
    });

    it('with a file that is only a cut line too', async () => {
      await mkdir(join(dir, 'nested'), { recursive: true });
      await writeFile(path, truncated);

      await file.append({ envelope: envelope('after-crash', 'W1'), raw: undefined });

      expect(JSON.parse((await readFile(path, 'utf8')).split('\n')[1]!).envelope.id).toBe('after-crash');
    });
  });

  it('does not lose what arrives while it replays: appends go on during an outage', async () => {
    await file.append({ envelope: envelope('saved', 'W1'), raw: undefined });
    await file.append({ envelope: envelope('kept', 'W2'), raw: undefined });

    const result = await file.replay(async ({ envelope: e }) => {
      await file.append({ envelope: envelope(`while-${e.id}`, `W-${e.id}`), raw: undefined });
      if (e.id === 'kept') throw new Error('still failing');
    });

    expect(result).toEqual({ saved: 1, kept: 1, rejected: 0 });
    const ids = (await readFile(path, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line).envelope.id);
    expect(ids).toEqual(['kept', 'while-saved', 'while-kept']);
  });

  it('does not remove the file when everything was saved but something new arrived meanwhile', async () => {
    await file.append({ envelope: envelope('saved', 'W1'), raw: undefined });

    await file.replay(async () => {
      await file.append({ envelope: envelope('late', 'W2'), raw: undefined });
    });

    const lines = (await readFile(path, 'utf8')).trim().split(/\r?\n/);
    expect(lines.map((line) => JSON.parse(line).envelope.id)).toEqual(['late']);
  });

  it('runs replays one at a time, so two of them never save an entry twice', async () => {
    await file.append({ envelope: envelope('once', 'W1'), raw: undefined });
    const seen: string[] = [];
    const save = async ({ envelope: e }: { envelope: UnifiedEnvelope }) => {
      await new Promise((resolve) => setImmediate(resolve));
      seen.push(e.id);
    };

    await Promise.all([file.replay(save), file.replay(save)]);

    expect(seen).toEqual(['once']);
    expect(existsSync(path)).toBe(false);
  });

  it('keeps entries appended at the same time, each on its own line', async () => {
    await Promise.all(['a', 'b', 'c', 'd'].map((id) => file.append({ envelope: envelope(id, id), raw: undefined })));

    const lines = (await readFile(path, 'utf8')).trim().split(/\r?\n/);
    expect(lines.map((line) => JSON.parse(line).envelope.id).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('replaying with no file is nothing to do', async () => {
    expect(await file.replay(async () => { throw new Error('unexpected'); })).toEqual({ saved: 0, kept: 0, rejected: 0 });
  });
});
