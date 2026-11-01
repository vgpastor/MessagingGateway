/**
 * The failed log end to end: a store that keeps failing sends the message to the file through
 * the real pipeline, and the next start stores it in a real message log and empties the file.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../../../src/core/event-bus.js';
import { Events } from '../../../src/core/events.js';
import type { MessageInboundPayload } from '../../../src/core/events.js';
import { InboundPipeline } from '../../../src/core/inbound/inbound-pipeline.js';
import { noopMediaService } from '../../../src/core/inbound/media-service.js';
import { noopMetrics } from '../../../src/core/metrics/metrics.port.js';
import type { ChannelAccount } from '../../../src/core/accounts/channel-account.js';
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
    await pipeline.handle(account, envelope('m4', 'W4'), { n: 4 });

    const page = await store.queryAfter({ accountId: 'wa-1', afterAccountSeq: 0, limit: 10 });
    expect(page.messages.map((m) => [m.id, m.accountSeq])).toEqual([['m1', 1], ['m2', 2], ['m3', 3], ['m4', 4]]);
    expect(emitted).toEqual([undefined, undefined, undefined, 4]);
    expect(media.resumePendingMedia).toHaveBeenCalled();
    await pipeline.drain(10);
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

    expect(result).toEqual({ saved: 3, kept: 0 });
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
    expect(result).toEqual({ saved: 2, kept: 1 });
    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).envelope.id).toBe('bad');
  });

  it('leaves the file alone when nothing could be stored', async () => {
    await file.append({ envelope: envelope('bad', 'W1'), raw: undefined });
    const before = await readFile(path, 'utf8');

    const result = await file.replay(async () => { throw new Error('db down'); });

    expect(result).toEqual({ saved: 0, kept: 1 });
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('keeps a line it cannot read (a crash mid-write) without losing the others', async () => {
    await file.append({ envelope: envelope('ok', 'W1'), raw: undefined });
    await writeFile(path, `${await readFile(path, 'utf8')}{"envelope":{"id":"trunc`);

    const result = await file.replay(async () => {});

    expect(result).toEqual({ saved: 1, kept: 1 });
    expect((await readFile(path, 'utf8')).trim()).toBe('{"envelope":{"id":"trunc');
  });

  it('does not lose what arrives while it replays: appends go on during an outage', async () => {
    await file.append({ envelope: envelope('saved', 'W1'), raw: undefined });
    await file.append({ envelope: envelope('kept', 'W2'), raw: undefined });

    const result = await file.replay(async ({ envelope: e }) => {
      await file.append({ envelope: envelope(`while-${e.id}`, `W-${e.id}`), raw: undefined });
      if (e.id === 'kept') throw new Error('still failing');
    });

    expect(result).toEqual({ saved: 1, kept: 1 });
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
    expect(await file.replay(async () => { throw new Error('unexpected'); })).toEqual({ saved: 0, kept: 0 });
  });
});
