import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ChannelAccount } from '../../src/core/accounts/channel-account.js';
import type { InboundPipeline } from '../../src/core/inbound/inbound-pipeline.js';

// A fake WhatsApp socket per makeWASocket(); the test drives its 'messages.upsert'.
const sockets: Array<{ ev: EventEmitter }> = [];

vi.mock('@whiskeysockets/baileys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@whiskeysockets/baileys')>()),
  default: () => {
    const socket = { ev: new EventEmitter(), logout: async () => {}, end: () => {} };
    sockets.push(socket);
    return socket;
  },
  useMultiFileAuthState: async () => ({ state: {}, saveCreds: () => {} }),
  fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
}));

const { baileysProvider } = await import('../../src/integrations/whatsapp/baileys/index.js');
const { ProviderRegistry } = await import('../../src/integrations/provider-registry.js');
const { InMemoryAccountRepository } = await import('../../src/infrastructure/config/in-memory-account.repository.js');
const { MessageRouterService } = await import('../../src/core/routing/message-router.service.js');
const { WebhookForwarder } = await import('../../src/connections/webhooks/webhook-forwarder.js');
const { CredentialValidator } = await import('../../src/infrastructure/credential-validator.js');
const { createServer } = await import('../../src/infrastructure/server.js');
const { connectManagedProviders } = await import('../../src/infrastructure/connect-managed-providers.js');
const { EventBus } = await import('../../src/core/event-bus.js');

const flush = () => new Promise((r) => setImmediate(r));
const HEADERS = { 'x-api-key': 'test-api-key' };

function waMessage(id = 'ABC123') {
  return {
    key: { remoteJid: '34600111222@s.whatsapp.net', id, fromMe: false },
    pushName: 'Ana',
    messageTimestamp: 1_700_000_000,
    message: { conversation: 'hola' },
  };
}

function newAccountBody(id: string) {
  return {
    id, alias: id, channel: 'whatsapp', provider: 'baileys',
    identity: { phoneNumber: '+34600000001' },
    metadata: { owner: 'org', tags: [] },
  };
}

describe('accounts created at runtime', () => {
  const ids: string[] = [];
  const eventBus = new EventBus();
  const inbound = { handle: vi.fn(async () => {}) };
  let app: FastifyInstance;
  let registry: InstanceType<typeof ProviderRegistry>;
  let repository: InstanceType<typeof InMemoryAccountRepository>;
  let wireSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    registry = new ProviderRegistry();
    registry.register(baileysProvider);
    repository = new InMemoryAccountRepository([]);
    wireSpy = vi.spyOn(baileysProvider, 'wireEvents');
    app = await createServer({
      accountRepository: repository,
      webhookConfigRepo: {} as never,
      providerRegistry: registry,
      messageRouter: new MessageRouterService(repository, registry),
      credentialValidator: new CredentialValidator(registry),
      webhookForwarder: new WebhookForwarder({} as never, undefined, undefined),
      wireAccount: (account) => registry.getOrThrow(account.provider).wireEvents!(account, eventBus, inbound as unknown as InboundPipeline),
      apiKey: 'test-api-key',
      port: 0,
      logLevel: 'silent',
    });
    await app.ready();
  });

  afterAll(async () => {
    wireSpy.mockRestore();
    await app.close();
  });

  afterEach(async () => {
    inbound.handle.mockClear();
    for (const id of ids.splice(0)) {
      await rm(resolve(process.cwd(), 'data', 'baileys-auth', id), { recursive: true, force: true });
    }
  });

  async function create(id: string) {
    ids.push(id);
    const response = await app.inject({ method: 'POST', url: '/api/v1/accounts', headers: HEADERS, payload: newAccountBody(id) });
    expect(response.statusCode).toBe(201);
  }

  it('wires events once when the account is created and then connected', async () => {
    await create('hot-1');
    const connect = await app.inject({ method: 'POST', url: '/api/v1/accounts/hot-1/connect', headers: HEADERS });
    expect(connect.statusCode).toBe(200);

    const forThisAccount = wireSpy.mock.calls.filter(([account]) => (account as ChannelAccount).id === 'hot-1');
    expect(forThisAccount.length).toBeGreaterThanOrEqual(1);

    sockets.at(-1)!.ev.emit('messages.upsert', { messages: [waMessage()], type: 'notify' });
    await flush();

    expect(inbound.handle).toHaveBeenCalledTimes(1);
  });

  it('delivers every inbound message of an account that was never wired at boot', async () => {
    await create('hot-2');
    await app.inject({ method: 'POST', url: '/api/v1/accounts/hot-2/connect', headers: HEADERS });

    sockets.at(-1)!.ev.emit('messages.upsert', { messages: [waMessage('M1'), waMessage('M2')], type: 'notify' });
    await flush();

    expect(inbound.handle).toHaveBeenCalledTimes(2);
  });

  it('wireEvents called twice for one account handles each inbound message once', async () => {
    ids.push('hot-3');
    const account = {
      id: 'hot-3', alias: 'hot-3', channel: 'whatsapp', provider: 'baileys', providerConfig: {},
      identity: { channel: 'whatsapp', phoneNumber: '+34600000001' },
      metadata: { owner: 'org', environment: 'production', tags: [] },
    } as unknown as ChannelAccount;
    const pipeline = { handle: vi.fn(async () => {}) };
    await baileysProvider.connection!().connect('hot-3', {});

    await baileysProvider.wireEvents!(account, eventBus, pipeline as unknown as InboundPipeline);
    await baileysProvider.wireEvents!(account, eventBus, pipeline as unknown as InboundPipeline);

    sockets.at(-1)!.ev.emit('messages.upsert', { messages: [waMessage()], type: 'notify' });
    await flush();

    expect(pipeline.handle).toHaveBeenCalledTimes(1);
  });

  it('shares the guard with the boot wiring: wired at boot, then connected through the API, still once', async () => {
    ids.push('hot-4');
    const account = {
      id: 'hot-4', alias: 'hot-4', channel: 'whatsapp', provider: 'baileys', status: 'unchecked', providerConfig: {},
      credentialsRef: '',
      identity: { channel: 'whatsapp', phoneNumber: '+34600000001' },
      metadata: { owner: 'org', environment: 'production', tags: [] },
    } as unknown as ChannelAccount;
    await connectManagedProviders([account], registry, eventBus, inbound as unknown as InboundPipeline);
    await repository.save(account);

    const connect = await app.inject({ method: 'POST', url: '/api/v1/accounts/hot-4/connect', headers: HEADERS });
    expect(connect.statusCode).toBe(200);

    sockets.at(-1)!.ev.emit('messages.upsert', { messages: [waMessage()], type: 'notify' });
    await flush();

    expect(inbound.handle).toHaveBeenCalledTimes(1);
  });

  it('wires again after a disconnect forgot the handlers (re-pairing keeps delivering)', async () => {
    await create('hot-5');
    await app.inject({ method: 'POST', url: '/api/v1/accounts/hot-5/connect', headers: HEADERS });
    await app.inject({ method: 'POST', url: '/api/v1/accounts/hot-5/disconnect', headers: HEADERS });
    await app.inject({ method: 'POST', url: '/api/v1/accounts/hot-5/connect', headers: HEADERS });

    sockets.at(-1)!.ev.emit('messages.upsert', { messages: [waMessage()], type: 'notify' });
    await flush();

    expect(inbound.handle).toHaveBeenCalledTimes(1);
  });

  async function waitForNewSocket(before: number): Promise<void> {
    for (let i = 0; i < 400 && sockets.length === before; i++) await new Promise((r) => setTimeout(r, 5));
    expect(sockets.length).toBeGreaterThan(before);
  }

  it('wires again when GET /accounts/:id auto-reconnects after a disconnect', async () => {
    await create('hot-7');
    await app.inject({ method: 'POST', url: '/api/v1/accounts/hot-7/connect', headers: HEADERS });
    await app.inject({ method: 'POST', url: '/api/v1/accounts/hot-7/disconnect', headers: HEADERS });
    const before = sockets.length;

    const response = await app.inject({ method: 'GET', url: '/api/v1/accounts/hot-7', headers: HEADERS });
    expect(response.statusCode).toBe(200);
    await waitForNewSocket(before);

    sockets.at(-1)!.ev.emit('messages.upsert', { messages: [waMessage()], type: 'notify' });
    await flush();

    expect(inbound.handle).toHaveBeenCalledTimes(1);
  });

  it('wires again when POST /accounts/:id/reset re-pairs after a disconnect', async () => {
    await create('hot-8');
    await app.inject({ method: 'POST', url: '/api/v1/accounts/hot-8/connect', headers: HEADERS });
    await app.inject({ method: 'POST', url: '/api/v1/accounts/hot-8/disconnect', headers: HEADERS });
    const before = sockets.length;

    const response = await app.inject({ method: 'POST', url: '/api/v1/accounts/hot-8/reset', headers: HEADERS });
    expect(response.statusCode).toBe(200);
    await waitForNewSocket(before);

    sockets.at(-1)!.ev.emit('messages.upsert', { messages: [waMessage()], type: 'notify' });
    await flush();

    expect(inbound.handle).toHaveBeenCalledTimes(1);
  });

  it('wires again when POST /accounts/:id/pair opens the connection after a disconnect', async () => {
    await create('hot-9');
    await app.inject({ method: 'POST', url: '/api/v1/accounts/hot-9/connect', headers: HEADERS });
    await app.inject({ method: 'POST', url: '/api/v1/accounts/hot-9/disconnect', headers: HEADERS });
    const before = sockets.length;

    // The fake socket has no requestPairingCode, so the request ends 400; the connection is what matters.
    await app.inject({ method: 'POST', url: '/api/v1/accounts/hot-9/pair', headers: HEADERS, payload: { phoneNumber: '+34600000009' } });
    expect(sockets.length).toBeGreaterThan(before);

    sockets.at(-1)!.ev.emit('messages.upsert', { messages: [waMessage()], type: 'notify' });
    await flush();

    expect(inbound.handle).toHaveBeenCalledTimes(1);
  });

  it('still creates and connects the account when wiring fails', async () => {
    wireSpy.mockRejectedValueOnce(new Error('wire exploded'));
    ids.push('hot-6');
    const created = await app.inject({ method: 'POST', url: '/api/v1/accounts', headers: HEADERS, payload: newAccountBody('hot-6') });

    expect(created.statusCode).toBe(201);
    const connect = await app.inject({ method: 'POST', url: '/api/v1/accounts/hot-6/connect', headers: HEADERS });
    expect(connect.statusCode).toBe(200);
  });
});
