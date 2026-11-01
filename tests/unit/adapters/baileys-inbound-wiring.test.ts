import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ChannelAccount } from '../../../src/core/accounts/channel-account.js';
import type { InboundPipeline } from '../../../src/core/inbound/inbound-pipeline.js';

// A fake WhatsApp socket per connect(): the test drives its 'messages.upsert'.
const sockets: Array<{ ev: EventEmitter; logout: () => Promise<void> }> = [];
const groupMetadata = vi.fn(async (jid: string): Promise<unknown> => ({ id: jid, subject: 'Grupo', participants: [] }));

vi.mock('@whiskeysockets/baileys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@whiskeysockets/baileys')>()),
  default: () => {
    const ev = new EventEmitter();
    const socket = { ev, logout: async () => {}, groupMetadata };
    sockets.push(socket);
    return socket;
  },
  useMultiFileAuthState: async () => ({ state: {}, saveCreds: () => {} }),
  fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
}));

const { createBaileysProvider } = await import('../../../src/integrations/whatsapp/baileys/index.js');
const baileysProvider = createBaileysProvider();
const { EventBus } = await import('../../../src/core/event-bus.js');
const { InboundPipeline: RealInboundPipeline } = await import('../../../src/core/inbound/inbound-pipeline.js');
const { SqliteMessageStore } = await import('../../../src/persistence/sqlite-message-store.js');
const { noopMediaService } = await import('../../../src/core/inbound/media-service.js');
const { noopMetrics } = await import('../../../src/core/metrics/metrics.port.js');
const { Events } = await import('../../../src/core/events.js');
const { WAMessageStubType } = await import('@whiskeysockets/baileys');

const flush = () => new Promise((r) => setImmediate(r));

function waMessage(overrides: Record<string, unknown> = {}) {
  return {
    key: { remoteJid: '34600111222@s.whatsapp.net', id: 'ABC123', fromMe: false },
    pushName: 'Ana',
    messageTimestamp: 1_700_000_000,
    message: { conversation: 'hola' },
    ...overrides,
  };
}

describe('Baileys inbound wiring', () => {
  const accounts: string[] = [];
  afterEach(async () => {
    for (const id of accounts.splice(0)) {
      await rm(resolve(process.cwd(), 'data', 'baileys-auth', id), { recursive: true, force: true });
    }
  });

  async function setup(accountId: string) {
    accounts.push(accountId);
    const inbound = { handle: vi.fn(async () => {}) };
    const account = {
      id: accountId, alias: accountId, channel: 'whatsapp', provider: 'baileys', providerConfig: {},
      identity: { channel: 'whatsapp', phoneNumber: '+34600000001' },
      metadata: { owner: 'org', environment: 'production', tags: [] },
    } as unknown as ChannelAccount;
    await baileysProvider.connection!().connect(accountId, {});
    await baileysProvider.wireEvents!(account, new EventBus(), inbound as unknown as InboundPipeline);
    return { inbound, account, socket: sockets.at(-1)! };
  }

  it('hands every received message to the pipeline with the raw message', async () => {
    const { inbound, account, socket } = await setup('wire-1');
    const msg = waMessage();

    socket.ev.emit('messages.upsert', { messages: [msg], type: 'append' });
    await flush();

    expect(inbound.handle).toHaveBeenCalledTimes(1);
    expect(inbound.handle).toHaveBeenCalledWith(
      account,
      expect.objectContaining({ direction: 'inbound', conversationId: '34600111222@s.whatsapp.net', accountId: 'wire-1' }),
      msg,
      expect.any(Function),
    );
  });

  it('accepts notify and append upserts only', async () => {
    const { inbound, socket } = await setup('wire-types');

    socket.ev.emit('messages.upsert', { messages: [waMessage()], type: 'notify' });
    socket.ev.emit('messages.upsert', { messages: [waMessage()], type: 'append' });
    await flush();
    expect(inbound.handle).toHaveBeenCalledTimes(2);

    socket.ev.emit('messages.upsert', { messages: [waMessage()], type: 'other' });
    await flush();
    expect(inbound.handle).toHaveBeenCalledTimes(2);
  });

  it('drops status@broadcast', async () => {
    const { inbound, socket } = await setup('wire-status');

    socket.ev.emit('messages.upsert', {
      messages: [waMessage({ key: { remoteJid: 'status@broadcast', id: 'ST1', fromMe: false, participant: '34600111222@s.whatsapp.net' } })],
      type: 'notify',
    });
    await flush();

    expect(inbound.handle).not.toHaveBeenCalled();
  });

  it('skips own messages and does not inline media as base64', async () => {
    const { inbound, socket } = await setup('wire-2');
    const image = waMessage({
      key: { remoteJid: '34600111222@s.whatsapp.net', id: 'IMG1', fromMe: false },
      message: { imageMessage: { mimetype: 'image/jpeg', fileLength: 10, mediaKey: Buffer.alloc(32), directPath: '/p' } },
    });

    socket.ev.emit('messages.upsert', {
      messages: [waMessage({ key: { remoteJid: '34600111222@s.whatsapp.net', id: 'OWN', fromMe: true } }), image],
      type: 'notify',
    });
    await flush();

    expect(inbound.handle).toHaveBeenCalledTimes(1);
    const envelope = (inbound.handle.mock.calls[0] as unknown as [unknown, { content: { media?: Record<string, unknown> } }])[1];
    expect(envelope.content.media).toBeDefined();
    expect(envelope.content.media).not.toHaveProperty('base64');
  });
});

describe('Baileys inbound wiring: order and robustness', () => {
  const accounts: string[] = [];
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  const GROUP = '120363000000000001@g.us';
  const DM = '34600111222@s.whatsapp.net';
  const inChat = (remoteJid: string, id: string) => waMessage({ key: { remoteJid, id, fromMe: false, participant: remoteJid === GROUP ? DM : undefined } });

  afterEach(async () => {
    vi.useRealTimers();
    groupMetadata.mockReset();
    groupMetadata.mockImplementation(async (jid) => ({ id: jid, subject: 'Grupo', participants: [] }));
    for (const id of accounts.splice(0)) {
      await rm(resolve(process.cwd(), 'data', 'baileys-auth', id), { recursive: true, force: true });
    }
  });

  async function setupReal(accountId: string) {
    accounts.push(accountId);
    const store = new SqliteMessageStore(':memory:');
    await store.init();
    await store.runMigrations();
    const pipeline = new RealInboundPipeline({ store, eventBus: new EventBus(), media: noopMediaService, metrics: noopMetrics, accounts: { findById: async () => undefined } });
    const account = {
      id: accountId, alias: accountId, channel: 'whatsapp', provider: 'baileys', providerConfig: {},
      identity: { channel: 'whatsapp', phoneNumber: '+34600000001' },
      metadata: { owner: 'org', environment: 'production', tags: [] },
    } as unknown as ChannelAccount;
    const provider = createBaileysProvider();
    await provider.connection!().connect(accountId, {});
    await provider.wireEvents!(account, new EventBus(), pipeline);
    const seqOf = async (id: string) => (await store.findByWaMessageId(accountId, id))?.accountSeq;
    return { store, seqOf, socket: sockets.at(-1)! };
  }

  it('numbers messages in arrival order even when the first one waits for its group name', async () => {
    const { store, seqOf, socket } = await setupReal('order-group');
    let answer = (_metadata: unknown) => {};
    groupMetadata.mockImplementationOnce(() => new Promise((r) => { answer = r; }));

    socket.ev.emit('messages.upsert', { messages: [inChat(GROUP, 'FIRST')], type: 'notify' });
    socket.ev.emit('messages.upsert', { messages: [inChat(DM, 'SECOND')], type: 'notify' });
    await settle();
    expect(await store.maxAccountSeq('order-group')).toBe(0);

    answer({ id: GROUP, subject: 'Grupo', participants: [] });
    await settle();

    expect(await seqOf('FIRST')).toBe(1);
    expect(await seqOf('SECOND')).toBe(2);
    const stored = await store.findByWaMessageId('order-group', 'FIRST');
    expect((stored?.channelDetails as Record<string, unknown>)['groupName']).toBe('Grupo');
    await store.close();
  });

  it('keeps the order of an upsert against the next one', async () => {
    const { seqOf, socket, store } = await setupReal('order-batch');

    socket.ev.emit('messages.upsert', { messages: [inChat(DM, 'A'), inChat(DM, 'B')], type: 'append' });
    socket.ev.emit('messages.upsert', { messages: [inChat(DM, 'C')], type: 'notify' });
    await settle();

    expect([await seqOf('A'), await seqOf('B'), await seqOf('C')]).toEqual([1, 2, 3]);
    await store.close();
  });

  it('a group lookup that hangs delays the queue for a bounded time, once per group', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { seqOf, socket, store } = await setupReal('order-hung');
    groupMetadata.mockImplementation(() => new Promise(() => {}));

    socket.ev.emit('messages.upsert', { messages: [inChat(GROUP, 'H1'), inChat(GROUP, 'H2'), inChat(DM, 'H3')], type: 'notify' });
    await settle();
    expect(await seqOf('H1')).toBeUndefined();

    await vi.advanceTimersByTimeAsync(5_000);
    await settle();

    expect([await seqOf('H1'), await seqOf('H2'), await seqOf('H3')]).toEqual([1, 2, 3]);
    expect(groupMetadata).toHaveBeenCalledTimes(1);
    await store.close();
  });

  it('a message that cannot even be read does not stop the rest nor reject', async () => {
    const { seqOf, socket, store } = await setupReal('poison');
    const poison = { get key(): never { throw new Error('malformed'); } };

    socket.ev.emit('messages.upsert', { messages: [poison, inChat(DM, 'AFTER')], type: 'notify' });
    await settle();

    expect(await seqOf('AFTER')).toBe(1);
    await store.close();
  });
});

describe('Baileys inbound wiring: messages that failed to decrypt', () => {
  const accounts: string[] = [];
  afterEach(async () => {
    for (const id of accounts.splice(0)) {
      await rm(resolve(process.cwd(), 'data', 'baileys-auth', id), { recursive: true, force: true });
    }
  });

  /** Real pipeline over a real (in-memory) message log: what is stored and emitted is what consumers get. */
  async function setupReal(accountId: string) {
    accounts.push(accountId);
    const store = new SqliteMessageStore(':memory:');
    await store.init();
    await store.runMigrations();
    const eventBus = new EventBus();
    const emitted: Array<{ content: { type: string; body?: string }; accountSeq?: number }> = [];
    eventBus.on<{ envelope: (typeof emitted)[number] }>(Events.MESSAGE_INBOUND, (e) => { emitted.push(e.data.envelope); });
    const pipeline = new RealInboundPipeline({ store, eventBus, media: noopMediaService, metrics: noopMetrics, accounts: { findById: async () => undefined } });
    const metrics = { ...noopMetrics, inboundSkipped: vi.fn() };
    const provider = createBaileysProvider({ metrics });
    const account = {
      id: accountId, alias: accountId, channel: 'whatsapp', provider: 'baileys', providerConfig: {},
      identity: { channel: 'whatsapp', phoneNumber: '+34600000001' },
      metadata: { owner: 'org', environment: 'production', tags: [] },
    } as unknown as ChannelAccount;
    await provider.connection!().connect(accountId, {});
    await provider.wireEvents!(account, eventBus, pipeline);
    return { store, emitted, metrics, socket: sockets.at(-1)! };
  }

  const settle = async () => { for (let i = 0; i < 5; i++) await flush(); };

  it('a CIPHERTEXT stub is not logged, so the real message with the same id is stored and emitted once with its content', async () => {
    const { store, emitted, metrics, socket } = await setupReal('wire-cipher-1');
    const stub = waMessage({
      key: { remoteJid: '34600111222@s.whatsapp.net', id: 'RETRY1', fromMe: false },
      message: null,
      messageStubType: WAMessageStubType.CIPHERTEXT,
      messageStubParameters: ['No session found to decrypt message'],
    });
    const real = waMessage({ key: { remoteJid: '34600111222@s.whatsapp.net', id: 'RETRY1', fromMe: false }, message: { conversation: 'real content' } });

    socket.ev.emit('messages.upsert', { messages: [stub], type: 'notify' });
    await settle();
    socket.ev.emit('messages.upsert', { messages: [real], type: 'notify' });
    await settle();

    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.content).toEqual({ type: 'text', body: 'real content' });
    expect(emitted[0]!.accountSeq).toBe(1);
    const stored = await store.findByWaMessageId('wire-cipher-1', 'RETRY1');
    expect(stored?.content).toEqual({ type: 'text', body: 'real content' });
    expect(await store.maxAccountSeq('wire-cipher-1')).toBe(1);
    expect(metrics.inboundSkipped).toHaveBeenCalledTimes(1);
    expect(metrics.inboundSkipped).toHaveBeenCalledWith('ciphertext_stub');
    await store.close();
  });

  it('a message without any content is skipped and counted as empty', async () => {
    const { store, emitted, metrics, socket } = await setupReal('wire-cipher-2');

    socket.ev.emit('messages.upsert', {
      messages: [waMessage({ key: { remoteJid: '34600111222@s.whatsapp.net', id: 'EMPTY1', fromMe: false }, message: undefined })],
      type: 'notify',
    });
    await settle();

    expect(emitted).toHaveLength(0);
    expect(await store.findByWaMessageId('wire-cipher-2', 'EMPTY1')).toBeUndefined();
    expect(metrics.inboundSkipped).toHaveBeenCalledWith('empty');
    await store.close();
  });
});
