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
import type { WebhookConfig, WebhookConfigInput } from '../../src/core/webhooks/webhook-config.js';
import type { WebhookConfigRepository } from '../../src/core/webhooks/webhook-config.repository.js';

class InMemoryWebhookConfigRepo implements WebhookConfigRepository {
  private configs = new Map<string, WebhookConfig>();
  async findByAccountId(accountId: string) { return this.configs.get(accountId); }
  async findAll() { return [...this.configs.values()]; }
  async upsert(accountId: string, input: WebhookConfigInput) {
    const now = new Date().toISOString();
    const existing = this.configs.get(accountId);
    const config: WebhookConfig = {
      accountId, url: input.url, secret: input.secret,
      events: input.events ?? ['*'], enabled: input.enabled ?? true,
      createdAt: existing?.createdAt ?? now, updatedAt: now,
    };
    this.configs.set(accountId, config);
    return config;
  }
  async remove(accountId: string) { return this.configs.delete(accountId); }
}

let app: FastifyInstance;

beforeAll(async () => {
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
    port: 0,
    logLevel: 'silent',
  });

  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('GET /health', () => {
  it('should return health status', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.status).toBe('ok');
    expect(body.timestamp).toBeDefined();
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.uptime).toBeGreaterThan(0);
  });
});

describe('GET /api/v1/accounts', () => {
  it('should return all accounts without credentials', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/accounts' });
    expect(response.statusCode).toBe(200);

    const accounts = response.json();
    expect(accounts.length).toBeGreaterThan(0);

    for (const account of accounts) {
      expect(account.id).toBeDefined();
      expect(account.alias).toBeDefined();
      expect(account.channel).toBeDefined();
      expect(account.provider).toBeDefined();
      expect(account.status).toBeDefined();
      // No credentials exposed
      expect(account.credentialsRef).toBeUndefined();
      expect(account.providerConfig).toBeUndefined();
    }
  });

  it('should filter by channel', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/accounts?channel=whatsapp',
    });
    expect(response.statusCode).toBe(200);

    const accounts = response.json();
    expect(accounts.length).toBe(4);
    for (const account of accounts) {
      expect(account.channel).toBe('whatsapp');
    }
  });

  it('should filter by owner', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/accounts?owner=test-org',
    });
    expect(response.statusCode).toBe(200);

    const accounts = response.json();
    expect(accounts.length).toBeGreaterThan(0);
    for (const account of accounts) {
      expect(account.metadata.owner).toBe('test-org');
    }
  });
});

describe('GET /api/v1/accounts/:id', () => {
  it('should return specific account', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/accounts/wa-acme',
    });
    expect(response.statusCode).toBe(200);

    const account = response.json();
    expect(account.id).toBe('wa-acme');
    expect(account.alias).toBe('Acme WhatsApp');
  });

  it('should return 404 for unknown account', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/accounts/nonexistent',
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('GET /api/v1/accounts/:id/health', () => {
  it('should return account health status', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/accounts/wa-acme/health',
    });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.accountId).toBe('wa-acme');
    expect(body.status).toBe('unchecked');
    expect(body.credentialsConfigured).toBe(false);
    expect(body.lastChecked).toBeDefined();
  });
});

describe('POST /api/v1/messages/send', () => {
  it('should return 400 when missing from and routing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/messages/send',
      payload: {
        to: '+34612345678',
        content: { type: 'text', body: 'Hello' },
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('should return 404 for unknown account ID', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/messages/send',
      payload: {
        from: 'nonexistent-account',
        to: '+34612345678',
        content: { type: 'text', body: 'Hello' },
      },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('POST /webhooks/whatsapp/:accountId/inbound', () => {
  it('should process valid WhatsApp inbound webhook', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp/wa-acme/inbound',
      payload: {
        event: 'message',
        data: {
          id: { _serialized: 'wamid.test123' },
          from: '34699000001@c.us',
          to: '34600000001@c.us',
          body: 'He encontrado un DEA en la calle Mayor',
          type: 'chat',
          timestamp: 1709100600,
          fromMe: false,
          hasMedia: false,
          hasQuotedMsg: false,
          isForwarded: false,
          isStatus: false,
          notifyName: 'Ciudadano',
          chat: {
            id: { _serialized: '34699000001@c.us' },
            name: 'Ciudadano',
            isGroup: false,
          },
        },
      },
    });

    expect(response.statusCode).toBe(200);

    const envelope = response.json();
    expect(envelope.id).toMatch(/^msg_/);
    expect(envelope.accountId).toBe('wa-acme');
    expect(envelope.channel).toBe('whatsapp');
    expect(envelope.direction).toBe('inbound');
    expect(envelope.sender.id).toBe('34699000001@c.us');
    expect(envelope.sender.displayName).toBe('Ciudadano');
    expect(envelope.content.type).toBe('text');
    expect(envelope.content.body).toBe('He encontrado un DEA en la calle Mayor');
    expect(envelope.channelDetails.messageId).toBe('wamid.test123');
    expect(envelope.channelDetails.platform).toBe('whatsapp');
    expect(envelope.gateway.adapterId).toBe('wwebjs-api');
    expect(envelope.gateway.account.id).toBe('wa-acme');
    expect(envelope.gateway.account.owner).toBe('acme-corp');
  });

  it('should return 404 for unknown account', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp/nonexistent/inbound',
      payload: { event: 'message', data: { id: { _serialized: 'x' } } },
    });
    expect(response.statusCode).toBe(404);
  });

  it('should return 400 for non-WhatsApp account', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp/tg-alerts-bot/inbound',
      payload: { event: 'message', data: { id: { _serialized: 'x' } } },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('POST /webhooks/whatsapp/:accountId/status', () => {
  it('should process status update', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp/wa-acme/status',
      payload: {
        event: 'message_ack',
        data: {
          id: { _serialized: 'wamid.sent123' },
          status: 3,
          timestamp: 1709100700,
          to: '34699000001@c.us',
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.received).toBe(true);
  });
});

describe('Swagger UI', () => {
  it('should serve Swagger UI at /docs', async () => {
    const response = await app.inject({ method: 'GET', url: '/docs/' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
  });

  it('should serve OpenAPI spec at /docs/json', async () => {
    const response = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(response.statusCode).toBe(200);

    const spec = response.json();
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.title).toBe('Unified Messaging Gateway');
    expect(spec.paths['/health']).toBeDefined();
    expect(spec.paths['/api/v1/accounts']).toBeDefined();
    expect(spec.paths['/api/v1/messages/send']).toBeDefined();
    expect(spec.paths['/webhooks/whatsapp/{accountId}/inbound']).toBeDefined();
  });
});

describe('Webhook Config API', () => {
  it('should return 404 when no webhook configured for account', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/accounts/wa-acme/webhook',
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe('WEBHOOK_NOT_CONFIGURED');
  });

  it('should create webhook config via PUT', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/accounts/wa-acme/webhook',
      payload: {
        url: 'https://n8n.example.com/webhook/acme',
        secret: 'test-secret',
        events: ['message.inbound'],
      },
    });
    expect(response.statusCode).toBe(200);

    const config = response.json();
    expect(config.accountId).toBe('wa-acme');
    expect(config.url).toBe('https://n8n.example.com/webhook/acme');
    expect(config.secret).toBe('test-secret');
    expect(config.events).toEqual(['message.inbound']);
    expect(config.enabled).toBe(true);
    expect(config.createdAt).toBeDefined();
    expect(config.updatedAt).toBeDefined();
  });

  it('should return existing webhook config via GET', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/accounts/wa-acme/webhook',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().url).toBe('https://n8n.example.com/webhook/acme');
  });

  it('should update webhook config via PUT', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/accounts/wa-acme/webhook',
      payload: {
        url: 'https://new-url.example.com/webhook',
        enabled: false,
      },
    });
    expect(response.statusCode).toBe(200);

    const config = response.json();
    expect(config.url).toBe('https://new-url.example.com/webhook');
    expect(config.enabled).toBe(false);
    expect(config.events).toEqual(['*']); // default when not specified
  });

  it('should list all webhook configs', async () => {
    // Add a second webhook
    await app.inject({
      method: 'PUT',
      url: '/api/v1/accounts/wa-test/webhook',
      payload: { url: 'https://test-org.example.com/hook' },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/webhooks',
    });
    expect(response.statusCode).toBe(200);

    const configs = response.json();
    expect(configs.length).toBe(2);
  });

  it('should delete webhook config', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/accounts/wa-acme/webhook',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().deleted).toBe(true);

    // Verify it's gone
    const getResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/accounts/wa-acme/webhook',
    });
    expect(getResponse.statusCode).toBe(404);
  });

  it('should return 404 for unknown account on PUT', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/accounts/nonexistent/webhook',
      payload: { url: 'https://example.com' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe('ACCOUNT_NOT_FOUND');
  });
});

describe('GET /openapi.json', () => {
  it('should serve the OpenAPI spec at root level for external tools', async () => {
    const response = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.headers['cache-control']).toBe('public, max-age=300');

    const spec = response.json();
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.title).toBe('Unified Messaging Gateway');
    expect(spec.paths['/api/v1/messages/send']).toBeDefined();
  });
});

describe('POST /api/v1/accounts', () => {
  it('should create a new account', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/accounts',
      payload: {
        id: 'wa-test-new',
        alias: 'Test WhatsApp',
        channel: 'whatsapp',
        provider: 'wwebjs-api',
        identity: { phoneNumber: '+34600099999' },
        credentialsRef: 'WWEBJS_TEST',
        metadata: {
          owner: 'test-org',
          tags: ['test'],
        },
      },
    });

    expect(response.statusCode).toBe(201);

    const account = response.json();
    expect(account.id).toBe('wa-test-new');
    expect(account.alias).toBe('Test WhatsApp');
    expect(account.channel).toBe('whatsapp');
    expect(account.provider).toBe('wwebjs-api');
    expect(account.status).toBe('unchecked');
    expect(account.metadata.owner).toBe('test-org');
    expect(account.metadata.tags).toEqual(['test']);
    // No credentials exposed
    expect(account.credentialsRef).toBeUndefined();
    expect(account.providerConfig).toBeUndefined();
  });

  it('should return 409 for duplicate account ID', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/accounts',
      payload: {
        id: 'wa-acme',
        alias: 'Duplicate',
        channel: 'whatsapp',
        provider: 'wwebjs-api',
        identity: { phoneNumber: '+34600000000' },
        credentialsRef: 'WWEBJS_DUP',
        metadata: { owner: 'test' },
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('ACCOUNT_ALREADY_EXISTS');
  });

  it('should return 400 for invalid payload', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/accounts',
      payload: {
        id: '',
        alias: 'Missing fields',
        channel: 'invalid-channel',
        provider: 'wwebjs-api',
        identity: {},
        credentialsRef: 'REF',
        metadata: { owner: 'test' },
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('should be retrievable after creation', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/accounts/wa-test-new',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().id).toBe('wa-test-new');
  });
});

describe('PUT /api/v1/accounts/:id', () => {
  it('should update an existing account', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/accounts/wa-test-new',
      payload: {
        alias: 'Updated WhatsApp',
        metadata: {
          tags: ['test', 'updated'],
        },
      },
    });

    expect(response.statusCode).toBe(200);

    const account = response.json();
    expect(account.id).toBe('wa-test-new');
    expect(account.alias).toBe('Updated WhatsApp');
    expect(account.metadata.tags).toEqual(['test', 'updated']);
    // Owner should be preserved from original
    expect(account.metadata.owner).toBe('test-org');
  });

  it('should return 404 for unknown account', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/accounts/nonexistent',
      payload: { alias: 'Nope' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe('ACCOUNT_NOT_FOUND');
  });
});

describe('DELETE /api/v1/accounts/:id', () => {
  it('should delete an existing account', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/accounts/wa-test-new',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().deleted).toBe(true);
    expect(response.json().accountId).toBe('wa-test-new');
  });

  it('should return 404 after deletion', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/accounts/wa-test-new',
    });

    expect(response.statusCode).toBe(404);
  });

  it('should return 404 for unknown account', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/accounts/nonexistent',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe('ACCOUNT_NOT_FOUND');
  });
});
