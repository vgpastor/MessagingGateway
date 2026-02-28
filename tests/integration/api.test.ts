import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { resolve } from 'node:path';
import { loadAccountsFromYaml } from '../../src/infrastructure/config/accounts.loader.js';
import { InMemoryAccountRepository } from '../../src/infrastructure/config/in-memory-account.repository.js';
import { AdapterFactory } from '../../src/adapters/adapter.factory.js';
import { HealthCheckerRegistry } from '../../src/adapters/health-checker.registry.js';
import { MessageRouterService } from '../../src/domain/routing/message-router.service.js';
import { WebhookForwarder } from '../../src/infrastructure/webhook-forwarder.js';
import { CredentialValidator } from '../../src/infrastructure/credential-validator.js';
import { createServer } from '../../src/infrastructure/server.js';

let app: FastifyInstance;

beforeAll(async () => {
  const accounts = loadAccountsFromYaml(
    resolve(process.cwd(), 'src/infrastructure/config/accounts.yaml'),
  );
  const accountRepository = new InMemoryAccountRepository(accounts);
  const adapterFactory = new AdapterFactory();
  const healthCheckerRegistry = new HealthCheckerRegistry();
  const credentialValidator = new CredentialValidator(healthCheckerRegistry);
  const messageRouter = new MessageRouterService(accountRepository, adapterFactory);
  const webhookForwarder = new WebhookForwarder(undefined, undefined);

  app = await createServer({
    accountRepository,
    messageRouter,
    adapterFactory,
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
    expect(body.version).toBe('1.0.0');
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
    expect(accounts.length).toBe(3);
    for (const account of accounts) {
      expect(account.channel).toBe('whatsapp');
    }
  });

  it('should filter by owner', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/accounts?owner=patroltech',
    });
    expect(response.statusCode).toBe(200);

    const accounts = response.json();
    expect(accounts.length).toBeGreaterThan(0);
    for (const account of accounts) {
      expect(account.metadata.owner).toBe('patroltech');
    }
  });
});

describe('GET /api/v1/accounts/:id', () => {
  it('should return specific account', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/accounts/wa-samur',
    });
    expect(response.statusCode).toBe(200);

    const account = response.json();
    expect(account.id).toBe('wa-samur');
    expect(account.alias).toBe('SAMUR WhatsApp');
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
      url: '/api/v1/accounts/wa-samur/health',
    });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.accountId).toBe('wa-samur');
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
      url: '/webhooks/whatsapp/wa-samur/inbound',
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
    expect(envelope.accountId).toBe('wa-samur');
    expect(envelope.channel).toBe('whatsapp');
    expect(envelope.direction).toBe('inbound');
    expect(envelope.sender.id).toBe('34699000001@c.us');
    expect(envelope.sender.displayName).toBe('Ciudadano');
    expect(envelope.contentSummary.type).toBe('text');
    expect(envelope.contentSummary.preview).toBe('He encontrado un DEA en la calle Mayor');
    expect(envelope.contentSummary.hasMedia).toBe(false);
    expect(envelope.channelPayload.messageId).toBe('wamid.test123');
    expect(envelope.channelPayload.message.type).toBe('text');
    expect(envelope.channelPayload.message.body).toBe('He encontrado un DEA en la calle Mayor');
    expect(envelope.gateway.adapterId).toBe('wwebjs-api');
    expect(envelope.gateway.account.id).toBe('wa-samur');
    expect(envelope.gateway.account.owner).toBe('global-emergency');
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
      url: '/webhooks/whatsapp/tg-deamap-bot/inbound',
      payload: { event: 'message', data: { id: { _serialized: 'x' } } },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('POST /webhooks/whatsapp/:accountId/status', () => {
  it('should process status update', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp/wa-samur/status',
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
    expect(body.messageId).toBe('wamid.sent123');
    expect(body.status).toBe('read');
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
