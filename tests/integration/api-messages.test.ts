/**
 * Integration tests for the messages controller endpoints.
 *
 * Uses a real SQLite in-memory store with test data, wired into
 * a Fastify server via createServer(). All HTTP calls go through app.inject().
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { resolve } from 'node:path';
import { loadAccountsFromYaml } from '../../src/infrastructure/config/accounts.loader.js';
import { InMemoryAccountRepository } from '../../src/infrastructure/config/in-memory-account.repository.js';
import { ProviderRegistry } from '../../src/integrations/provider-registry.js';
import { wwebjsProvider } from '../../src/integrations/whatsapp/wwebjs-api/index.js';
import { MessageRouterService } from '../../src/core/routing/message-router.service.js';
import { WebhookForwarder } from '../../src/connections/webhooks/webhook-forwarder.js';
import { CredentialValidator } from '../../src/infrastructure/credential-validator.js';
import { createServer } from '../../src/infrastructure/server.js';
import { SqliteMessageStore } from '../../src/persistence/sqlite-message-store.js';
import type { WebhookConfig, WebhookConfigInput } from '../../src/core/webhooks/webhook-config.js';
import type { WebhookConfigRepository } from '../../src/core/webhooks/webhook-config.repository.js';
import { createWebhookId } from '../../src/core/webhooks/webhook-config.js';
import type { UnifiedEnvelope } from '../../src/core/messaging/unified-envelope.js';

// ── In-memory webhook config repo (same as api.test.ts) ──────

class InMemoryWebhookConfigRepo implements WebhookConfigRepository {
  private configs: WebhookConfig[] = [];

  async findByAccountId(accountId: string): Promise<WebhookConfig[]> {
    return this.configs.filter((c) => c.accountId === accountId);
  }
  async findById(webhookId: string): Promise<WebhookConfig | undefined> {
    return this.configs.find((c) => c.id === webhookId);
  }
  async findAll(): Promise<WebhookConfig[]> { return [...this.configs]; }
  async add(accountId: string, input: WebhookConfigInput): Promise<WebhookConfig> {
    const now = new Date().toISOString();
    const config: WebhookConfig = {
      id: createWebhookId(),
      accountId, url: input.url, secret: input.secret,
      events: input.events ?? ['*'], filters: input.filters, enabled: input.enabled ?? true,
      createdAt: now, updatedAt: now,
    };
    this.configs.push(config);
    return config;
  }
  async update(webhookId: string, input: Partial<WebhookConfigInput>): Promise<WebhookConfig | undefined> {
    const config = this.configs.find((c) => c.id === webhookId);
    if (!config) return undefined;
    if (input.url !== undefined) config.url = input.url;
    if (input.secret !== undefined) config.secret = input.secret;
    if (input.events !== undefined) config.events = input.events.length ? input.events : ['*'];
    if (input.enabled !== undefined) config.enabled = input.enabled;
    if (input.filters !== undefined) config.filters = input.filters;
    config.updatedAt = new Date().toISOString();
    return config;
  }
  async remove(webhookId: string): Promise<boolean> {
    const idx = this.configs.findIndex((c) => c.id === webhookId);
    if (idx === -1) return false;
    this.configs.splice(idx, 1);
    return true;
  }
  async removeByAccountId(accountId: string): Promise<number> {
    const before = this.configs.length;
    this.configs = this.configs.filter((c) => c.accountId !== accountId);
    return before - this.configs.length;
  }
}

// ── Test fixtures ────────────────────────────────────────────

const testEnvelopes: UnifiedEnvelope[] = [
  {
    id: 'msg-001',
    accountId: 'wa-test',
    channel: 'whatsapp',
    direction: 'inbound',
    timestamp: new Date('2026-04-05T10:00:00Z'),
    conversationId: '34600000001@s.whatsapp.net',
    sender: { id: '34600000001@s.whatsapp.net', displayName: 'Alice' },
    recipient: { id: '+34600000099' },
    content: { type: 'text', body: 'Hello, I need help with my order' },
    gateway: {
      receivedAt: new Date('2026-04-05T10:00:00Z'),
      adapterId: 'baileys',
      account: { id: 'wa-test', alias: 'Test WA', owner: 'test-org', tags: ['whatsapp'] },
    },
  },
  {
    id: 'msg-002',
    accountId: 'wa-test',
    channel: 'whatsapp',
    direction: 'outbound',
    timestamp: new Date('2026-04-05T10:01:00Z'),
    conversationId: '34600000001@s.whatsapp.net',
    sender: { id: '+34600000099', displayName: 'Support Agent' },
    recipient: { id: '34600000001@s.whatsapp.net' },
    content: { type: 'text', body: 'Sure, let me check your order status' },
    gateway: {
      receivedAt: new Date('2026-04-05T10:01:00Z'),
      adapterId: 'baileys',
      account: { id: 'wa-test', alias: 'Test WA', owner: 'test-org', tags: ['whatsapp'] },
    },
  },
  {
    id: 'msg-003',
    accountId: 'wa-test',
    channel: 'whatsapp',
    direction: 'inbound',
    timestamp: new Date('2026-04-05T10:02:00Z'),
    conversationId: '34600000001@s.whatsapp.net',
    sender: { id: '34600000001@s.whatsapp.net', displayName: 'Alice' },
    recipient: { id: '+34600000099' },
    content: { type: 'image', media: { mimeType: 'image/jpeg' }, caption: 'Order screenshot' },
    gateway: {
      receivedAt: new Date('2026-04-05T10:02:00Z'),
      adapterId: 'baileys',
      account: { id: 'wa-test', alias: 'Test WA', owner: 'test-org', tags: ['whatsapp'] },
    },
  },
  {
    id: 'msg-004',
    accountId: 'wa-test',
    channel: 'whatsapp',
    direction: 'inbound',
    timestamp: new Date('2026-04-05T10:03:00Z'),
    conversationId: '34600000002@s.whatsapp.net',
    sender: { id: '34600000002@s.whatsapp.net', displayName: 'Bob' },
    recipient: { id: '+34600000099' },
    content: { type: 'text', body: 'Good morning, any updates?' },
    gateway: {
      receivedAt: new Date('2026-04-05T10:03:00Z'),
      adapterId: 'baileys',
      account: { id: 'wa-test', alias: 'Test WA', owner: 'test-org', tags: ['whatsapp'] },
    },
  },
  {
    id: 'msg-005',
    accountId: 'tg-test',
    channel: 'telegram',
    direction: 'inbound',
    timestamp: new Date('2026-04-05T10:04:00Z'),
    conversationId: 'tg-chat-001',
    sender: { id: 'tg-user-001', displayName: 'Charlie' },
    recipient: { id: 'tg-bot-001' },
    content: { type: 'text', body: 'Telegram test message' },
    gateway: {
      receivedAt: new Date('2026-04-05T10:04:00Z'),
      adapterId: 'telegram-bot-api',
      account: { id: 'tg-test', alias: 'Test TG', owner: 'test-org', tags: ['telegram'] },
    },
  },
];

// ── Setup ────────────────────────────────────────────────────

let app: FastifyInstance;
let store: SqliteMessageStore;

const AUTH_HEADERS = { 'x-api-key': 'test-api-key' };

beforeAll(async () => {
  // Create in-memory SQLite store
  store = new SqliteMessageStore(':memory:');
  await store.init();
  await store.runMigrations();

  // Seed test data
  for (const envelope of testEnvelopes) {
    await store.save(envelope);
  }

  // Build server with the message store wired in
  const accounts = loadAccountsFromYaml(
    resolve(process.cwd(), 'tests/fixtures/accounts.yaml'),
  );
  const accountRepository = new InMemoryAccountRepository(accounts);
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(wwebjsProvider);
  const credentialValidator = new CredentialValidator(providerRegistry);
  const messageRouter = new MessageRouterService(accountRepository, providerRegistry);
  const webhookConfigRepo = new InMemoryWebhookConfigRepo();
  const webhookForwarder = new WebhookForwarder(webhookConfigRepo, undefined, undefined);

  app = await createServer({
    accountRepository,
    webhookConfigRepo,
    providerRegistry,
    messageRouter,
    credentialValidator,
    webhookForwarder,
    messageStore: store,
    apiKey: 'test-api-key',
    port: 0,
    logLevel: 'silent',
  });

  await app.ready();
});

afterAll(async () => {
  await app.close();
  await store.close();
});

// ── GET /api/v1/messages ─────────────────────────────────────

describe('GET /api/v1/messages', () => {
  it('should return messages with default pagination', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/messages', headers: AUTH_HEADERS });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.messages).toHaveLength(5);
    expect(body.total).toBe(5);
    expect(body.limit).toBeDefined();
    expect(body.offset).toBeDefined();
  });

  it('should filter by accountId', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/messages?accountId=wa-test',
      headers: AUTH_HEADERS,
    });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.messages).toHaveLength(4);
    for (const msg of body.messages) {
      expect(msg.accountId).toBe('wa-test');
    }
  });

  it('should filter by conversationId', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/messages?conversationId=34600000001@s.whatsapp.net',
      headers: AUTH_HEADERS,
    });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.messages).toHaveLength(3);
    for (const msg of body.messages) {
      expect(msg.conversationId).toBe('34600000001@s.whatsapp.net');
    }
  });

  it('should filter by direction=inbound', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/messages?direction=inbound',
      headers: AUTH_HEADERS,
    });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.messages).toHaveLength(4);
    for (const msg of body.messages) {
      expect(msg.direction).toBe('inbound');
    }
  });

  it('should return empty result when no matches', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/messages?accountId=nonexistent',
      headers: AUTH_HEADERS,
    });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.messages).toHaveLength(0);
    expect(body.total).toBe(0);
  });
});

// ── GET /api/v1/messages/:id ─────────────────────────────────

describe('GET /api/v1/messages/:id', () => {
  it('should return message by ID', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/messages/msg-001',
      headers: AUTH_HEADERS,
    });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.id).toBe('msg-001');
    expect(body.content.body).toBe('Hello, I need help with my order');
    expect(body.channel).toBe('whatsapp');
  });

  it('should return 404 for unknown ID with MESSAGE_NOT_FOUND code', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/messages/msg-nonexistent',
      headers: AUTH_HEADERS,
    });
    expect(res.statusCode).toBe(404);

    const body = res.json();
    expect(body.code).toBe('MESSAGE_NOT_FOUND');
  });
});

// ── GET /api/v1/messages/search ──────────────────────────────

describe('GET /api/v1/messages/search', () => {
  it('should return matching messages for search query', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/messages/search?q=order',
      headers: AUTH_HEADERS,
    });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.messages.length).toBeGreaterThanOrEqual(2);
    const ids = body.messages.map((m: UnifiedEnvelope) => m.id);
    expect(ids).toContain('msg-001');
    expect(ids).toContain('msg-002');
  });

  it('should return 400 when q is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/messages/search',
      headers: AUTH_HEADERS,
    });
    expect(res.statusCode).toBe(400);

    const body = res.json();
    // Fastify schema validation catches missing required param before handler
    expect(body.code).toBeDefined();
  });

  it('should filter search by accountId', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/messages/search?q=test&accountId=tg-test',
      headers: AUTH_HEADERS,
    });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    for (const msg of body.messages) {
      expect(msg.accountId).toBe('tg-test');
    }
  });
});

// ── GET /api/v1/messages/analytics ───────────────────────────

describe('GET /api/v1/messages/analytics', () => {
  it('should return stats shape with byChannel, byDirection, byContentType', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/messages/analytics',
      headers: AUTH_HEADERS,
    });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.totalMessages).toBe(5);
    expect(body.byChannel).toBeDefined();
    expect(body.byChannel.whatsapp).toBe(4);
    expect(body.byChannel.telegram).toBe(1);
    expect(body.byDirection).toBeDefined();
    expect(body.byDirection.inbound).toBe(4);
    expect(body.byDirection.outbound).toBe(1);
    expect(body.byContentType).toBeDefined();
    expect(body.byContentType.text).toBe(4);
    expect(body.byContentType.image).toBe(1);
    expect(body.topConversations).toBeDefined();
    expect(body.byHour).toBeDefined();
  });

  it('should filter by since date', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/messages/analytics?since=2026-04-05T10:03:00Z',
      headers: AUTH_HEADERS,
    });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    // Only msg-004 and msg-005 are at or after 10:03
    expect(body.totalMessages).toBe(2);
  });
});

// ── GET /api/v1/messages/export ──────────────────────────────

describe('GET /api/v1/messages/export', () => {
  it('should return JSON by default', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/messages/export',
      headers: AUTH_HEADERS,
    });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.messages).toBeDefined();
    expect(body.messages.length).toBe(5);
  });

  it('should return CSV with correct content-type header when format=csv', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/messages/export?format=csv',
      headers: AUTH_HEADERS,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('messages.csv');

    const csv = res.body;
    const lines = csv.split('\n');
    // Header + 5 data rows
    expect(lines.length).toBe(6);
    expect(lines[0]).toContain('id');
    expect(lines[0]).toContain('timestamp');
    expect(lines[0]).toContain('channel');
  });
});

// ── GET /api/v1/conversations/:conversationId/context ────────

describe('GET /api/v1/conversations/:conversationId/context', () => {
  it('should return AI-ready conversation with messages array', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/conversations/34600000001@s.whatsapp.net/context',
      headers: AUTH_HEADERS,
    });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.conversationId).toBe('34600000001@s.whatsapp.net');
    expect(body.totalMessages).toBe(3);
    expect(body.messages).toHaveLength(3);
    expect(body.participantCount).toBe(2);

    // Messages in chronological order with roles
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content).toContain('Hello, I need help');
    expect(body.messages[1].role).toBe('assistant');
    expect(body.messages[1].content).toContain('order status');
    expect(body.messages[2].role).toBe('user');
  });

  it('should return with format=raw including envelopes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/conversations/34600000001@s.whatsapp.net/context?format=raw',
      headers: AUTH_HEADERS,
    });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.envelopes).toBeDefined();
    expect(body.envelopes.length).toBe(3);
    expect(body.envelopes[0].id).toBe('msg-001');
  });
});

// ── GET /api/v1/messages/stats ───────────────────────────────

describe('GET /api/v1/messages/stats', () => {
  it('should return total count', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/messages/stats',
      headers: AUTH_HEADERS,
    });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.total).toBe(5);
  });
});
