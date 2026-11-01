import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BufferJSON } from '@whiskeysockets/baileys';
import { parseBaileysConfig } from '../../../src/integrations/whatsapp/baileys/baileys.types.js';

// Capture the options each makeWASocket() call receives.
const captured: Array<Record<string, any>> = [];
const metadataCalls: string[] = [];

vi.mock('@whiskeysockets/baileys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@whiskeysockets/baileys')>()),
  default: (options: Record<string, unknown>) => {
    captured.push(options);
    return {
      ev: new EventEmitter(),
      logout: async () => {},
      groupMetadata: async (jid: string) => {
        metadataCalls.push(jid);
        return { id: jid, subject: 'Grupo', participants: [] };
      },
    };
  },
  useMultiFileAuthState: async () => ({ state: {}, saveCreds: () => {} }),
  fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
}));

const { BaileysSocketManager } = await import('../../../src/integrations/whatsapp/baileys/baileys-socket.manager.js');

const ACCOUNT = 'socket-options';

describe('markOnlineOnConnect', () => {
  it('defaults to false', () => {
    expect(parseBaileysConfig({}).markOnlineOnConnect).toBe(false);
  });

  it('can still be enabled explicitly', () => {
    expect(parseBaileysConfig({ markOnlineOnConnect: true }).markOnlineOnConnect).toBe(true);
  });
});

describe('Baileys socket options', () => {
  afterEach(async () => {
    captured.length = 0;
    metadataCalls.length = 0;
    await rm(resolve(process.cwd(), 'data', 'baileys-auth', ACCOUNT), { recursive: true, force: true });
  });

  it('does not mark the account online when the config says nothing', async () => {
    const manager = new BaileysSocketManager();
    await manager.connect(ACCOUNT, parseBaileysConfig({}));

    expect(captured[0]!['markOnlineOnConnect']).toBe(false);
  });

  it('gives the socket a retry counter cache that stores and forgets counters', async () => {
    const manager = new BaileysSocketManager();
    await manager.connect(ACCOUNT, {});

    const cache = captured[0]!['msgRetryCounterCache'];
    cache.set('msg-1', 2);
    expect(cache.get('msg-1')).toBe(2);
    cache.del('msg-1');
    expect(cache.get('msg-1')).toBeUndefined();
  });

  it('serves getMessage from the message lookup', async () => {
    const manager = new BaileysSocketManager({
      messageLookup: async (accountId, waMessageId) =>
        accountId === ACCOUNT && waMessageId === 'WA1' ? { conversation: 'hola' } : undefined,
    });
    await manager.connect(ACCOUNT, {});

    const getMessage = captured[0]!['getMessage'];
    expect(await getMessage({ id: 'WA1', remoteJid: 'x@s.whatsapp.net' })).toEqual({ conversation: 'hola' });
    expect(await getMessage({ id: 'OTHER', remoteJid: 'x@s.whatsapp.net' })).toBeUndefined();
  });

  it('getMessage answers undefined without a lookup, without an id, and when the lookup throws', async () => {
    const manager = new BaileysSocketManager();
    await manager.connect(ACCOUNT, {});
    const getMessage = captured[0]!['getMessage'];
    expect(await getMessage({ id: 'WA1' })).toBeUndefined();

    const failingManager = new BaileysSocketManager({ messageLookup: async () => { throw new Error('db down'); } });
    await failingManager.connect(ACCOUNT, {});
    const failing = captured[1]!['getMessage'];
    expect(await failing({ id: 'WA1' })).toBeUndefined();
    expect(await failing({})).toBeUndefined();
  });

  it('serves cachedGroupMetadata from group lookups already made', async () => {
    const manager = new BaileysSocketManager();
    await manager.connect(ACCOUNT, {});
    const cachedGroupMetadata = captured[0]!['cachedGroupMetadata'];
    expect(await cachedGroupMetadata('123@g.us')).toBeUndefined();

    await manager.getGroupInfo(ACCOUNT, '123@g.us');

    expect(metadataCalls).toEqual(['123@g.us']);
    expect(await cachedGroupMetadata('123@g.us')).toMatchObject({ id: '123@g.us', subject: 'Grupo' });
  });
});

describe('createBaileysMessageLookup', () => {
  it('finds a message we sent, so a recipient asking to retry gets it: adapter, router, subscriber and log for real', async () => {
    const { createBaileysMessageLookup } = await import('../../../src/integrations/whatsapp/baileys/baileys-message-lookup.js');
    const { BaileysAdapter } = await import('../../../src/integrations/whatsapp/baileys/baileys.adapter.js');
    const { MessageRouterService } = await import('../../../src/core/routing/message-router.service.js');
    const { EventBus } = await import('../../../src/core/event-bus.js');
    const { subscribePersistence } = await import('../../../src/persistence/persistence-subscriber.js');
    const { SqliteMessageStore } = await import('../../../src/persistence/sqlite-message-store.js');
    const { proto } = await import('@whiskeysockets/baileys');

    const store = new SqliteMessageStore(':memory:');
    await store.init();
    await store.runMigrations();
    const eventBus = new EventBus();
    subscribePersistence(eventBus, store);

    const sent = proto.WebMessageInfo.fromObject({
      key: { remoteJid: '34600111222@s.whatsapp.net', id: 'SENT1', fromMe: true },
      message: { conversation: 'hola, soy el gateway' },
      messageTimestamp: 1760900000,
    });
    const socket = { sendMessage: async () => sent };
    const adapter = new BaileysAdapter({ accountId: ACCOUNT }, ACCOUNT, undefined, { getSocket: () => socket } as never);
    const account = {
      id: ACCOUNT, alias: 'a', channel: 'whatsapp', provider: 'baileys', status: 'active', providerConfig: {},
      identity: { channel: 'whatsapp', phoneNumber: '+34600000001' }, credentialsRef: '',
      metadata: { owner: 'o', environment: 'test', tags: [] },
    };
    const router = new MessageRouterService(
      { findById: async () => account } as never,
      { create: () => adapter } as never,
      eventBus,
    );

    const result = await router.send({ fromAccountId: ACCOUNT, to: '34600111222', content: { type: 'text', body: 'hola, soy el gateway' } });

    expect(result).not.toHaveProperty('providerRaw'); // callers (the API) never see the stored payload
    expect(result.messageId).toBe('SENT1');
    await vi.waitFor(async () => expect(await store.findByWaMessageId(ACCOUNT, 'SENT1')).toBeDefined());
    const message = await createBaileysMessageLookup(store)(ACCOUNT, 'SENT1');
    expect(message?.conversation).toBe('hola, soy el gateway');
    expect((await store.findByWaMessageId(ACCOUNT, 'SENT1'))?.accountSeq).toBeUndefined();
    await store.close();
  });

  it('revives the stored raw message into a proto message with its buffers', async () => {
    const { createBaileysMessageLookup } = await import('../../../src/integrations/whatsapp/baileys/baileys-message-lookup.js');
    const mediaKey = Buffer.alloc(32, 7);
    const raw = JSON.parse(JSON.stringify(
      { key: { id: 'WA1' }, message: { imageMessage: { mimetype: 'image/jpeg', mediaKey } } },
      BufferJSON.replacer,
    ));
    const store = { findByWaMessageId: vi.fn(async () => ({ raw })) };

    const message = await createBaileysMessageLookup(store as never)(ACCOUNT, 'WA1');
    expect(store.findByWaMessageId).toHaveBeenCalledWith(ACCOUNT, 'WA1');
    expect(message?.imageMessage?.mimetype).toBe('image/jpeg');
    expect(Buffer.from(message!.imageMessage!.mediaKey!).equals(mediaKey)).toBe(true);
  });

  it('answers undefined when the message is unknown, has no raw message, or the store fails', async () => {
    const { createBaileysMessageLookup } = await import('../../../src/integrations/whatsapp/baileys/baileys-message-lookup.js');
    const lookup = (found: unknown) => createBaileysMessageLookup({
      findByWaMessageId: async () => { if (found instanceof Error) throw found; return found; },
    } as never);

    expect(await lookup(undefined)(ACCOUNT, 'x')).toBeUndefined();
    expect(await lookup({ raw: undefined })(ACCOUNT, 'x')).toBeUndefined();
    expect(await lookup({ raw: { key: {} } })(ACCOUNT, 'x')).toBeUndefined();
    expect(await lookup(new Error('boom'))(ACCOUNT, 'x')).toBeUndefined();
  });
});
