/**
 * Integration tests for GET /api/v1/media/:id, backed by a real SQLite store
 * and a real DiskMediaStore on a temp directory.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadAccountsFromYaml } from '../../src/infrastructure/config/accounts.loader.js';
import { InMemoryAccountRepository } from '../../src/infrastructure/config/in-memory-account.repository.js';
import { ProviderRegistry } from '../../src/integrations/provider-registry.js';
import { wwebjsProvider } from '../../src/integrations/whatsapp/wwebjs-api/index.js';
import { MessageRouterService } from '../../src/core/routing/message-router.service.js';
import { WebhookForwarder } from '../../src/connections/webhooks/webhook-forwarder.js';
import { CredentialValidator } from '../../src/infrastructure/credential-validator.js';
import { createServer } from '../../src/infrastructure/server.js';
import { SqliteMessageStore } from '../../src/persistence/sqlite-message-store.js';
import { DiskMediaStore } from '../../src/persistence/media/disk-media-store.js';
import type { UnifiedEnvelope } from '../../src/core/messaging/unified-envelope.js';
import type { MediaInfo } from '../../src/core/messaging/content.js';
import type { WebhookConfigRepository } from '../../src/core/webhooks/webhook-config.repository.js';

const AUTH = { 'x-api-key': 'test-api-key' };

function imageEnvelope(id: string, media: MediaInfo): UnifiedEnvelope {
  return {
    id,
    accountId: 'wa-test',
    channel: 'whatsapp',
    direction: 'inbound',
    timestamp: new Date('2026-10-20T10:00:00Z'),
    conversationId: '34600000001@s.whatsapp.net',
    sender: { id: '34600000001@s.whatsapp.net' },
    recipient: { id: '+34600000099' },
    content: { type: 'image', media },
    gateway: {
      receivedAt: new Date('2026-10-20T10:00:00Z'),
      adapterId: 'baileys',
      account: { id: 'wa-test', alias: 'Test', owner: 'o', tags: [] },
    },
  } as UnifiedEnvelope;
}

let app: FastifyInstance;
let store: SqliteMessageStore;
let dir: string;
const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6]);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'api-media-'));
  const media = new DiskMediaStore(dir);
  store = new SqliteMessageStore(':memory:');
  await store.init();
  await store.runMigrations();

  await store.insertInbound(imageEnvelope('READY1', { mimeType: 'image/jpeg', status: 'pending' }), {});
  await media.write('wa-test', 'READY1', 'jpg', bytes);
  await store.updateMedia('READY1', { status: 'ready', size: bytes.length, url: '/api/v1/media/READY1' });

  await store.insertInbound(imageEnvelope('PEND1', { mimeType: 'image/jpeg', status: 'pending' }), {});
  await store.insertInbound(imageEnvelope('SKIP1', { mimeType: 'video/mp4', status: 'pending' }), {});
  await store.updateMedia('SKIP1', { status: 'skipped', skipReason: 'too_large' });
  await store.insertInbound(imageEnvelope('EXP1', { mimeType: 'image/jpeg', status: 'pending' }), {});
  await store.updateMedia('EXP1', { status: 'expired' });
  // Marked ready but the file is gone (purged): reported as expired.
  await store.insertInbound(imageEnvelope('GONE1', { mimeType: 'image/jpeg', status: 'pending' }), {});
  await store.updateMedia('GONE1', { status: 'ready', url: '/api/v1/media/GONE1' });
  await store.insertInbound({ ...imageEnvelope('TXT1', { mimeType: 'x' }), content: { type: 'text', body: 'hi' } } as UnifiedEnvelope, {});

  const accounts = loadAccountsFromYaml(resolve(process.cwd(), 'tests/fixtures/accounts.yaml'));
  const accountRepository = new InMemoryAccountRepository(accounts);
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(wwebjsProvider);
  const webhookConfigRepo = { findAll: async () => [], findByAccountId: async () => [] } as unknown as WebhookConfigRepository;

  app = await createServer({
    accountRepository,
    webhookConfigRepo,
    providerRegistry,
    messageRouter: new MessageRouterService(accountRepository, providerRegistry),
    credentialValidator: new CredentialValidator(providerRegistry),
    webhookForwarder: new WebhookForwarder(webhookConfigRepo, undefined, undefined),
    messageStore: store,
    mediaStore: media,
    apiKey: 'test-api-key',
    port: 0,
    logLevel: 'silent',
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await store.close();
  await rm(dir, { recursive: true, force: true });
});

describe('GET /api/v1/media/:id', () => {
  it('streams a ready media with its content type and length', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/media/READY1', headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['content-length']).toBe(String(bytes.length));
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.rawPayload.equals(bytes)).toBe(true);
  });

  it('answers 202 while the media is pending', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/media/PEND1', headers: AUTH });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: 'pending' });
  });

  it('answers 410 for skipped media, with the reason', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/media/SKIP1', headers: AUTH });
    expect(res.statusCode).toBe(410);
    expect(res.json()).toMatchObject({ status: 'skipped', skipReason: 'too_large' });
  });

  it('answers 410 for expired media', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/media/EXP1', headers: AUTH });
    expect(res.statusCode).toBe(410);
    expect(res.json()).toMatchObject({ status: 'expired' });
  });

  it('answers 410 when the media is ready but its file is gone', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/media/GONE1', headers: AUTH });
    expect(res.statusCode).toBe(410);
  });

  it('answers 404 for an unknown id and for a message without media', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/media/NOPE', headers: AUTH })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/v1/media/TXT1', headers: AUTH })).statusCode).toBe(404);
  });

  it('requires the API key', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/media/READY1' });
    expect(res.statusCode).toBe(401);
  });
});
