import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ChannelAccount } from '../../../src/core/accounts/channel-account.js';
import type { InboundPipeline } from '../../../src/core/inbound/inbound-pipeline.js';

// A fake WhatsApp socket per connect(): the test drives its 'messages.upsert'.
const sockets: Array<{ ev: EventEmitter; logout: () => Promise<void> }> = [];

vi.mock('@whiskeysockets/baileys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@whiskeysockets/baileys')>()),
  default: () => {
    const ev = new EventEmitter();
    const socket = { ev, logout: async () => {} };
    sockets.push(socket);
    return socket;
  },
  useMultiFileAuthState: async () => ({ state: {}, saveCreds: () => {} }),
  fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
}));

const { baileysProvider } = await import('../../../src/integrations/whatsapp/baileys/index.js');
const { EventBus } = await import('../../../src/core/event-bus.js');

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

  it('hands every received message to the pipeline with the upsert type and the raw message', async () => {
    const { inbound, account, socket } = await setup('wire-1');
    const msg = waMessage();

    socket.ev.emit('messages.upsert', { messages: [msg], type: 'append' });
    await flush();

    expect(inbound.handle).toHaveBeenCalledTimes(1);
    expect(inbound.handle).toHaveBeenCalledWith(
      account,
      expect.objectContaining({ direction: 'inbound', conversationId: '34600111222@s.whatsapp.net', accountId: 'wire-1' }),
      msg,
      'append',
    );
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
