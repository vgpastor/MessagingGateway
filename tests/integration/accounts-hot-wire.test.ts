import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ChannelAccount } from '../../src/core/accounts/channel-account.js';
import type { InboundPipeline } from '../../src/core/inbound/inbound-pipeline.js';

// A fake WhatsApp socket per makeWASocket(); the test drives its 'messages.upsert'.
const sockets: Array<{ ev: EventEmitter; logout: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; requestPairingCode: ReturnType<typeof vi.fn> }> = [];

vi.mock('@whiskeysockets/baileys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@whiskeysockets/baileys')>()),
  default: () => {
    const socket = { ev: new EventEmitter(), logout: vi.fn(async () => {}), end: vi.fn(), requestPairingCode: vi.fn(async () => 'ABCD1234') };
    sockets.push(socket);
    return socket;
  },
  useMultiFileAuthState: async () => ({ state: {}, saveCreds: () => {} }),
  fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
}));

const { createBaileysProvider } = await import('../../src/integrations/whatsapp/baileys/index.js');
const baileysProvider = createBaileysProvider();
const { ProviderRegistry } = await import('../../src/integrations/provider-registry.js');
const { InMemoryAccountRepository } = await import('../../src/infrastructure/config/in-memory-account.repository.js');
const { MessageRouterService } = await import('../../src/core/routing/message-router.service.js');
const { WebhookForwarder } = await import('../../src/connections/webhooks/webhook-forwarder.js');
const { CredentialValidator } = await import('../../src/infrastructure/credential-validator.js');
const { createServer } = await import('../../src/infrastructure/server.js');
const { connectManagedProviders } = await import('../../src/infrastructure/connect-managed-providers.js');
const { EventBus } = await import('../../src/core/event-bus.js');

const { createLogCapture } = await import('./helpers/test-server.js');

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

  it('GET /accounts/:id only reads: an account that was closed stays closed', async () => {
    await create('hot-7');
    await app.inject({ method: 'POST', url: '/api/v1/accounts/hot-7/connect', headers: HEADERS });
    await app.inject({ method: 'POST', url: '/api/v1/accounts/hot-7/disconnect', headers: HEADERS });
    const before = sockets.length;

    const response = await app.inject({ method: 'GET', url: '/api/v1/accounts/hot-7', headers: HEADERS });
    await new Promise((r) => setTimeout(r, 50));

    expect(response.statusCode).toBe(200);
    expect(response.json().connection.status).toBe('disconnected');
    expect(sockets).toHaveLength(before);
    expect(registry.getConnectionManager('baileys')!.hasConnection('hot-7')).toBe(false);
  });

  it('GET /accounts/:id does not open a socket for an account never connected', async () => {
    await create('hot-7b');
    const before = sockets.length;

    await app.inject({ method: 'GET', url: '/api/v1/accounts/hot-7b', headers: HEADERS });
    await new Promise((r) => setTimeout(r, 50));

    expect(sockets).toHaveLength(before);
  });

  it('reactivating a suspended account connects it, wired: at boot it was left out of both', async () => {
    ids.push('hot-10');
    await repository.save({ ...JSON.parse(JSON.stringify(newAccountBody('hot-10'))), status: 'suspended', providerConfig: {}, credentialsRef: '' });
    const before = sockets.length;

    const response = await app.inject({ method: 'PUT', url: '/api/v1/accounts/hot-10', headers: HEADERS, payload: { status: 'active' } });
    expect(response.statusCode).toBe(200);
    await waitForNewSocket(before);

    sockets.at(-1)!.ev.emit('messages.upsert', { messages: [waMessage()], type: 'notify' });
    await flush();

    expect(inbound.handle).toHaveBeenCalledTimes(1);
  });

  it('suspending a connected account closes its socket, keeps the session, and reactivating resumes it', async () => {
    await create('hot-10b');
    await app.inject({ method: 'POST', url: '/api/v1/accounts/hot-10b/connect', headers: HEADERS });
    const socket = sockets.at(-1)!;
    const authDir = resolve(process.cwd(), 'data', 'baileys-auth', 'hot-10b');
    await mkdir(authDir, { recursive: true });
    await writeFile(resolve(authDir, 'creds.json'), '{}');

    const suspended = await app.inject({ method: 'PUT', url: '/api/v1/accounts/hot-10b', headers: HEADERS, payload: { status: 'suspended' } });

    expect(suspended.statusCode).toBe(200);
    expect(socket.end).toHaveBeenCalledTimes(1);
    expect(socket.logout).not.toHaveBeenCalled();
    expect(existsSync(resolve(authDir, 'creds.json'))).toBe(true);
    expect(registry.getConnectionManager('baileys')!.hasConnection('hot-10b')).toBe(false);

    const before = sockets.length;
    await app.inject({ method: 'PUT', url: '/api/v1/accounts/hot-10b', headers: HEADERS, payload: { status: 'active' } });
    await waitForNewSocket(before);
    sockets.at(-1)!.ev.emit('messages.upsert', { messages: [waMessage()], type: 'notify' });
    await flush();

    expect(inbound.handle).toHaveBeenCalledTimes(1);
  });

  it('a PUT on an account already suspended closes nothing again', async () => {
    await create('hot-10c');
    await app.inject({ method: 'PUT', url: '/api/v1/accounts/hot-10c', headers: HEADERS, payload: { status: 'suspended' } });
    await baileysProvider.connection!().connect('hot-10c', {});
    const socket = sockets.at(-1)!;

    await app.inject({ method: 'PUT', url: '/api/v1/accounts/hot-10c', headers: HEADERS, payload: { alias: 'renamed' } });

    expect(socket.end).not.toHaveBeenCalled();
  });

  it('a PUT that does not reactivate opens nothing', async () => {
    await create('hot-11');
    const before = sockets.length;

    await app.inject({ method: 'PUT', url: '/api/v1/accounts/hot-11', headers: HEADERS, payload: { alias: 'renamed' } });
    await new Promise((r) => setTimeout(r, 50));

    expect(sockets).toHaveLength(before);
  });

  it('DELETE /accounts/:id closes the account: device unlinked, no socket, no retries, no session on disk', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      await create('hot-12');
      await app.inject({ method: 'POST', url: '/api/v1/accounts/hot-12/connect', headers: HEADERS });
      const socket = sockets.at(-1)!;
      const authDir = resolve(process.cwd(), 'data', 'baileys-auth', 'hot-12');
      await mkdir(authDir, { recursive: true });
      socket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });
      const before = sockets.length;

      const response = await app.inject({ method: 'DELETE', url: '/api/v1/accounts/hot-12', headers: HEADERS });
      await vi.advanceTimersByTimeAsync(600_000);

      expect(response.statusCode).toBe(200);
      expect(socket.logout).toHaveBeenCalledTimes(1);
      expect(registry.getConnectionManager('baileys')!.hasConnection('hot-12')).toBe(false);
      expect(sockets).toHaveLength(before);
      expect(existsSync(authDir)).toBe(false);
      expect(await repository.findById('hot-12')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('DELETE /accounts/:id releases what the connection manager keeps for the account', async () => {
    await create('hot-12b');
    await app.inject({ method: 'POST', url: '/api/v1/accounts/hot-12b/connect', headers: HEADERS });
    const socketManager = baileysProvider.connection!() as unknown as { socketManager: { getConnectionEnd(id: string): unknown } };

    await app.inject({ method: 'DELETE', url: '/api/v1/accounts/hot-12b', headers: HEADERS });

    expect(socketManager.socketManager.getConnectionEnd('hot-12b')).toBeUndefined();
  });

  it('POST /accounts/:id/disconnect keeps it closed: only DELETE forgets the account', async () => {
    await create('hot-12c');
    await app.inject({ method: 'POST', url: '/api/v1/accounts/hot-12c/connect', headers: HEADERS });
    const socketManager = baileysProvider.connection!() as unknown as { socketManager: { getConnectionEnd(id: string): unknown } };

    await app.inject({ method: 'POST', url: '/api/v1/accounts/hot-12c/disconnect', headers: HEADERS });

    expect(socketManager.socketManager.getConnectionEnd('hot-12c')).toBe('closed');
  });

  it('DELETE /accounts/:id still deletes the account when closing it fails', async () => {
    await create('hot-13');
    const manager = baileysProvider.connection!();
    const failing = vi.spyOn(registry, 'getConnectionManager').mockReturnValue({
      ...manager, disconnect: async () => { throw new Error('socket exploded'); },
    } as never);

    const response = await app.inject({ method: 'DELETE', url: '/api/v1/accounts/hot-13', headers: HEADERS });
    failing.mockRestore();

    expect(response.statusCode).toBe(200);
    expect(await repository.findById('hot-13')).toBeUndefined();
  });

  it('DELETE /accounts/:id answers 404 for an unknown account', async () => {
    const response = await app.inject({ method: 'DELETE', url: '/api/v1/accounts/nobody', headers: HEADERS });
    expect(response.statusCode).toBe(404);
  });

  it('POST /accounts refuses an id that is not a safe folder name, and the contract says so', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/accounts', headers: HEADERS, payload: newAccountBody('..') });
    const spec = await app.inject({ method: 'GET', url: '/openapi.json' });
    const body = spec.json().paths['/api/v1/accounts'].post.requestBody.content['application/json'].schema;

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('INVALID_PAYLOAD');
    expect(await repository.findById('..')).toBeUndefined();
    expect(body.properties.id.pattern).toBe('^[A-Za-z0-9][A-Za-z0-9_-]*$');
  });

  it('POST /accounts keeps the conversations it was given', async () => {
    ids.push('hot-14');
    const conversations = ['34600111222@s.whatsapp.net'];

    const response = await app.inject({
      method: 'POST', url: '/api/v1/accounts', headers: HEADERS, payload: { ...newAccountBody('hot-14'), conversations },
    });

    expect(response.statusCode).toBe(201);
    expect((await repository.findById('hot-14'))?.conversations).toEqual(conversations);
  });

  it.each([
    ['all', '*'],
    ['one', ['34600111222@s.whatsapp.net']],
    ['several', ['34600111222@s.whatsapp.net', '123@g.us']],
    ['none', []],
  ])('POST /accounts stores conversations as they came: %s', async (name, conversations) => {
    const id = `hot-14-${name}`;
    ids.push(id);

    const response = await app.inject({
      method: 'POST', url: '/api/v1/accounts', headers: HEADERS, payload: { ...newAccountBody(id), conversations },
    });

    expect(response.statusCode).toBe(201);
    expect((await repository.findById(id))?.conversations).toEqual(conversations);
  });

  it('POST /accounts refuses any other conversations, and the contract says so', async () => {
    ids.push('hot-14b');

    const response = await app.inject({
      method: 'POST', url: '/api/v1/accounts', headers: HEADERS, payload: { ...newAccountBody('hot-14b'), conversations: { all: true } },
    });
    const spec = await app.inject({ method: 'GET', url: '/openapi.json' });
    const body = spec.json().paths['/api/v1/accounts'].post.requestBody.content['application/json'].schema;

    expect(response.statusCode).toBe(400);
    expect(body.properties.conversations).toBeDefined();
    expect(await repository.findById('hot-14b')).toBeUndefined();
  });

  it.each([
    ['all', '*'],
    ['a list', ['34600111222@s.whatsapp.net']],
    ['none', []],
  ])('every account response tells the conversations: %s', async (name, conversations) => {
    const id = `hot-14d-${name.replace(' ', '-')}`;
    ids.push(id);

    const created = await app.inject({ method: 'POST', url: '/api/v1/accounts', headers: HEADERS, payload: { ...newAccountBody(id), conversations } });
    const read = await app.inject({ method: 'GET', url: `/api/v1/accounts/${id}`, headers: HEADERS });
    const listed = await app.inject({ method: 'GET', url: '/api/v1/accounts', headers: HEADERS });
    const updated = await app.inject({ method: 'PUT', url: `/api/v1/accounts/${id}`, headers: HEADERS, payload: { alias: 'renamed' } });

    expect(created.json().conversations).toEqual(conversations);
    expect(read.json().conversations).toEqual(conversations);
    expect(listed.json().find((a: { id: string }) => a.id === id).conversations).toEqual(conversations);
    expect(updated.json().conversations).toEqual(conversations);
  });

  it('GET /accounts/:id/health reports a suspended account as suspended, and leaves it so', async () => {
    ids.push('hot-15');
    await repository.save({ ...JSON.parse(JSON.stringify(newAccountBody('hot-15'))), status: 'suspended', providerConfig: {}, credentialsRef: '' });

    const response = await app.inject({ method: 'GET', url: '/api/v1/accounts/hot-15/health', headers: HEADERS });

    expect(response.json().status).toBe('suspended');
    expect((await repository.findById('hot-15'))?.status).toBe('suspended');
  });

  describe('POST /accounts/:id/disconnect', () => {
    it('logs out and deletes the session, and the next connect pairs from scratch', async () => {
      await create('hot-22');
      await app.inject({ method: 'POST', url: '/api/v1/accounts/hot-22/connect', headers: HEADERS });
      const socket = sockets.at(-1)!;
      const authDir = resolve(process.cwd(), 'data', 'baileys-auth', 'hot-22');
      await mkdir(authDir, { recursive: true });
      await writeFile(resolve(authDir, 'creds.json'), '{}');

      const response = await app.inject({ method: 'POST', url: '/api/v1/accounts/hot-22/disconnect', headers: HEADERS });

      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe('disconnected');
      expect(socket.logout).toHaveBeenCalledTimes(1);
      expect(existsSync(authDir)).toBe(false);
      expect(registry.getConnectionManager('baileys')!.hasConnection('hot-22')).toBe(false);

      const before = sockets.length;
      await app.inject({ method: 'POST', url: '/api/v1/accounts/hot-22/connect', headers: HEADERS });
      expect(sockets.length).toBe(before + 1);
    });

    it('does not wait for a logout that hangs for more than 5 s', async () => {
      await create('hot-23');
      await app.inject({ method: 'POST', url: '/api/v1/accounts/hot-23/connect', headers: HEADERS });
      const socket = sockets.at(-1)!;
      socket.logout.mockImplementation(() => new Promise(() => {}));
      const authDir = resolve(process.cwd(), 'data', 'baileys-auth', 'hot-23');
      await mkdir(authDir, { recursive: true });

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const pending = app.inject({ method: 'POST', url: '/api/v1/accounts/hot-23/disconnect', headers: HEADERS });
        await vi.advanceTimersByTimeAsync(5_000);
        vi.useRealTimers();
        const response = await pending;

        expect(response.statusCode).toBe(200);
        expect(socket.end).toHaveBeenCalled();
        expect(existsSync(authDir)).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('says so when the session could not be deleted', async () => {
      ids.push('hot-24');
      await repository.save({ ...JSON.parse(JSON.stringify(newAccountBody('hot-24'))), status: 'active', providerConfig: { authDir: '../outside' }, credentialsRef: '' });

      const response = await app.inject({ method: 'POST', url: '/api/v1/accounts/hot-24/disconnect', headers: HEADERS });

      expect(response.statusCode).toBe(500);
      expect(response.json().code).toBe('DISCONNECT_FAILED');
    });
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

    const pair = app.inject({ method: 'POST', url: '/api/v1/accounts/hot-9/pair', headers: HEADERS, payload: { phoneNumber: '+34600000009' } });
    await waitForNewSocket(before);
    sockets.at(-1)!.ev.emit('connection.update', { qr: 'QR' });
    expect((await pair).statusCode).toBe(200);

    sockets.at(-1)!.ev.emit('messages.upsert', { messages: [waMessage()], type: 'notify' });
    await flush();

    expect(inbound.handle).toHaveBeenCalledTimes(1);
  });

  describe('a suspended account opens no socket', () => {
    async function suspended(id: string) {
      await create(id);
      await app.inject({ method: 'PUT', url: `/api/v1/accounts/${id}`, headers: HEADERS, payload: { status: 'suspended' } });
    }

    it.each([
      ['connect', undefined],
      ['pair', { phoneNumber: '+34600000009' }],
      ['reset', undefined],
    ])('POST /accounts/:id/%s answers 409 and connects nothing', async (action, payload) => {
      const id = `hot-20-${action}`;
      await suspended(id);
      const before = sockets.length;

      const response = await app.inject({ method: 'POST', url: `/api/v1/accounts/${id}/${action}`, headers: HEADERS, payload });
      await new Promise((r) => setTimeout(r, 50));

      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('ACCOUNT_SUSPENDED');
      expect(sockets).toHaveLength(before);
      expect(registry.getConnectionManager('baileys')!.hasConnection(id)).toBe(false);
    });

    it('POST /accounts/:id/reset keeps the session of a suspended account', async () => {
      await suspended('hot-21');
      const authDir = resolve(process.cwd(), 'data', 'baileys-auth', 'hot-21');
      await mkdir(authDir, { recursive: true });
      await writeFile(resolve(authDir, 'creds.json'), '{}');

      await app.inject({ method: 'POST', url: '/api/v1/accounts/hot-21/reset', headers: HEADERS });

      expect(existsSync(resolve(authDir, 'creds.json'))).toBe(true);
    });

    it('declares the 409 in the contract', async () => {
      const paths = (await app.inject({ method: 'GET', url: '/openapi.json' })).json().paths;

      for (const action of ['connect', 'pair', 'reset']) {
        expect(paths[`/api/v1/accounts/{id}/${action}`].post.responses['409']).toBeDefined();
      }
    });
  });

  describe('PUT /accounts/:id validates what it stores', () => {
    async function put(id: string, payload: unknown) {
      return app.inject({ method: 'PUT', url: `/api/v1/accounts/${id}`, headers: HEADERS, payload: payload as object });
    }

    it.each([
      ['a word as conversations', { conversations: 'todo' }],
      ['a number as conversations', { conversations: 5 }],
      ['a list of numbers as conversations', { conversations: [1, 2] }],
      ['an identity of no channel', { identity: { foo: 'bar' } }],
      ['an identity that is not an object', { identity: 'wa' }],
      ['an unknown field', { nickname: 'x' }],
      ['an empty alias', { alias: '' }],
      ['an empty owner', { metadata: { owner: '' } }],
      ['half a rate limit', { metadata: { rateLimit: { maxPerMinute: 1 } } }],
    ])('refuses %s and changes nothing', async (_name, payload) => {
      await create('hot-16');
      const before = JSON.stringify(await repository.findById('hot-16'));

      const response = await put('hot-16', payload);

      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('INVALID_PAYLOAD');
      expect(JSON.stringify(await repository.findById('hot-16'))).toBe(before);
      await repository.remove('hot-16');
    });

    it('takes valid conversations, and a change of the alias alone resets nothing', async () => {
      await create('hot-17');
      const conversations = ['123@g.us'];

      expect((await put('hot-17', { status: 'active', conversations })).statusCode).toBe(200);
      expect((await put('hot-17', { alias: 'renamed' })).statusCode).toBe(200);

      const stored = await repository.findById('hot-17');
      expect(stored?.alias).toBe('renamed');
      expect(stored?.conversations).toEqual(conversations);
      expect(stored?.status).toBe('active');
    });

    it('refuses a provider that needs credentials on an account that has none: the next start could not load it', async () => {
      await create('hot-18');

      const response = await put('hot-18', { provider: 'twilio' });

      expect(response.statusCode).toBe(400);
      expect((await repository.findById('hot-18'))?.provider).toBe('baileys');
    });

    it('keeps the channel of the account in the identity, and the fields of an SMS one', async () => {
      await create('hot-19');

      const response = await put('hot-19', { identity: { phoneNumber: '+34600000002', senderId: 'ACME' } });

      expect(response.statusCode).toBe(200);
      expect((await repository.findById('hot-19'))?.identity).toEqual({ channel: 'whatsapp', phoneNumber: '+34600000002', senderId: 'ACME' });
    });

    it('declares conversations and refuses other fields in the contract', async () => {
      const spec = await app.inject({ method: 'GET', url: '/openapi.json' });
      const body = spec.json().paths['/api/v1/accounts/{id}'].put.requestBody.content['application/json'].schema;

      expect(body.properties.conversations.anyOf).toBeDefined();
      expect(body.additionalProperties).toBe(false);
    });
  });

  it('POST /accounts refuses a word as conversations, which the schema step would turn into a list', async () => {
    ids.push('hot-14c');

    const response = await app.inject({
      method: 'POST', url: '/api/v1/accounts', headers: HEADERS, payload: { ...newAccountBody('hot-14c'), conversations: 'todo' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('INVALID_PAYLOAD');
    expect(await repository.findById('hot-14c')).toBeUndefined();
  });

  it('POST /accounts/:id/pair asks for the code only once WhatsApp has answered the handshake', async () => {
    await create('hot-25');
    const before = sockets.length;

    const pair = app.inject({ method: 'POST', url: '/api/v1/accounts/hot-25/pair', headers: HEADERS, payload: { phoneNumber: '+34 600 000 009' } });
    await waitForNewSocket(before);
    const socket = sockets.at(-1)!;
    await new Promise((r) => setTimeout(r, 30));
    expect(socket.requestPairingCode).not.toHaveBeenCalled();

    socket.ev.emit('connection.update', { qr: 'QR' });
    const response = await pair;

    expect(response.statusCode).toBe(200);
    expect(response.json().pairingCode).toBe('ABCD1234');
    expect(socket.requestPairingCode).toHaveBeenCalledWith('34600000009');
  });

  it('POST /accounts/:id/pair logs the phone masked', async () => {
    const capture = createLogCapture();
    const logged = await createServer({
      accountRepository: repository,
      webhookConfigRepo: {} as never,
      providerRegistry: registry,
      messageRouter: new MessageRouterService(repository, registry),
      credentialValidator: new CredentialValidator(registry),
      webhookForwarder: new WebhookForwarder({} as never, undefined, undefined),
      apiKey: 'test-api-key',
      port: 0,
      logLevel: 'info',
      logStream: capture.stream,
    });
    await logged.ready();
    try {
      await create('hot-26');
      await baileysProvider.connection!().connect('hot-26', {});
      sockets.at(-1)!.ev.emit('connection.update', { qr: 'QR' });

      const response = await logged.inject({ method: 'POST', url: '/api/v1/accounts/hot-26/pair', headers: HEADERS, payload: { phoneNumber: '+34600000009' } });

      expect(response.statusCode).toBe(200);
      expect(capture.text()).toContain('Pairing code requested');
      expect(capture.text()).toContain('***0009');
      expect(capture.text()).not.toContain('34600000009');
    } finally {
      await logged.close();
    }
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
