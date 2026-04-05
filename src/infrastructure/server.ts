import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyWebsocket from '@fastify/websocket';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';

const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8')) as { version: string };
import type { ChannelAccountRepository } from '../core/accounts/channel-account.repository.js';
import type { WebhookConfigRepository } from '../core/webhooks/webhook-config.repository.js';
import type { MessageRouterService } from '../core/routing/message-router.service.js';
import type { ProviderLookupPort } from '../core/providers/provider-lookup.port.js';
import type { WebhookForwarder } from '../connections/webhooks/webhook-forwarder.js';
import type { CredentialValidator } from './credential-validator.js';
import type { HealthCheckScheduler } from './health-check-scheduler.js';
import type { WebSocketBroadcaster } from '../connections/ws/websocket-broadcaster.js';
import { createApiKeyGuard } from '../core/auth/api-key.guard.js';
import { healthController } from '../connections/api/health.controller.js';
import { accountsController } from '../connections/api/accounts.controller.js';
import { sendController } from '../connections/api/send.controller.js';
import { statusController } from '../connections/api/status.controller.js';
import { whatsappWebhookController } from '../connections/api/inbound/whatsapp-webhook.controller.js';
import { telegramWebhookController } from '../connections/api/inbound/telegram-webhook.controller.js';
import { emailWebhookController } from '../connections/api/inbound/email-webhook.controller.js';
import { smsWebhookController } from '../connections/api/inbound/sms-webhook.controller.js';
import { webhookConfigController } from '../connections/api/webhook-config.controller.js';
import { groupsController } from '../connections/api/groups.controller.js';
import { websocketController } from '../connections/ws/websocket.controller.js';
import { metricsController } from '../connections/api/metrics.controller.js';

export interface ServerDeps {
  accountRepository: ChannelAccountRepository;
  webhookConfigRepo: WebhookConfigRepository;
  providerRegistry: ProviderLookupPort;
  messageRouter: MessageRouterService;
  credentialValidator: CredentialValidator;
  healthCheckScheduler?: HealthCheckScheduler;
  webhookForwarder: WebhookForwarder;
  wsBroadcaster?: WebSocketBroadcaster;
  messageStore?: import('../core/persistence/message-store.port.js').FullMessageStorePort;
  apiKey: string;
  port: number;
  logLevel: string;
  metricsEnabled?: boolean;
}

export async function createServer(deps: ServerDeps) {
  const isDev = process.env['NODE_ENV'] !== 'production';
  const usePrettyLogs = process.env['NODE_ENV'] === 'development';

  const fastify = Fastify({
    logger: usePrettyLogs
      ? {
          level: deps.logLevel,
          transport: {
            target: 'pino-pretty',
            options: { colorize: true },
          },
        }
      : {
          level: deps.logLevel,
        },
  });

  fastify.removeContentTypeParser('application/json');
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, (body as string).length > 0 ? JSON.parse(body as string) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  await fastify.register(fastifyCors, {
    origin: process.env['CORS_ORIGIN'] ?? (isDev ? true : false),
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });

  await fastify.register(fastifyWebsocket);

  await fastify.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Unified Messaging Gateway',
        description:
          'Single point of contact for all messaging integrations. ' +
          'Abstracts WhatsApp, Telegram, Email, and SMS providers behind a unified API.',
        version: pkg.version,
      },
      tags: [
        { name: 'Health', description: 'Health check endpoints' },
        { name: 'Accounts', description: 'Account management and status' },
        { name: 'Messaging', description: 'Unified message sending API' },
        { name: 'Webhooks', description: 'Inbound message webhooks from providers' },
        { name: 'Webhooks Config', description: 'Per-account webhook configuration management' },
        { name: 'Groups', description: 'Group listing and metadata' },
        { name: 'WebSocket', description: 'Real-time bidirectional event streaming' },
      ],
    },
  });

  if (isDev || process.env['SWAGGER_ENABLED'] === 'true') {
    await fastify.register(fastifySwaggerUi, {
      routePrefix: '/docs',
      uiConfig: { docExpansion: 'list', deepLinking: true },
    });

    fastify.get('/openapi.json', { schema: { hide: true } }, async (_request, reply) => {
      return reply
        .header('content-type', 'application/json; charset=utf-8')
        .header('cache-control', 'public, max-age=300')
        .send(fastify.swagger());
    });
  }

  // ── Public routes (no auth) ──────────────────────────────────

  await fastify.register(healthController);

  if (deps.metricsEnabled !== false) {
    await fastify.register(metricsController);
  }

  // ── Inbound webhooks (provider-to-gateway, own signature validation) ──

  await fastify.register(
    async (instance) => whatsappWebhookController(instance, {
      accountRepository: deps.accountRepository,
      webhookForwarder: deps.webhookForwarder,
      providerRegistry: deps.providerRegistry,
    }),
  );

  await fastify.register(
    async (instance) => telegramWebhookController(instance, {
      accountRepository: deps.accountRepository,
      webhookForwarder: deps.webhookForwarder,
      providerRegistry: deps.providerRegistry,
    }),
  );

  await fastify.register(
    async (instance) => emailWebhookController(instance, {
      accountRepository: deps.accountRepository,
      webhookForwarder: deps.webhookForwarder,
    }),
  );

  await fastify.register(
    async (instance) => smsWebhookController(instance, {
      accountRepository: deps.accountRepository,
      webhookForwarder: deps.webhookForwarder,
    }),
  );

  // ── Authenticated API routes ────────────────────────────────

  const apiKeyGuard = createApiKeyGuard(deps.apiKey);

  await fastify.register(async (authenticated) => {
    authenticated.addHook('preHandler', apiKeyGuard);

    await authenticated.register(
      async (instance) => accountsController(instance, {
        accountRepository: deps.accountRepository,
        credentialValidator: deps.credentialValidator,
        healthCheckScheduler: deps.healthCheckScheduler,
        providerRegistry: deps.providerRegistry,
      }),
    );

    await authenticated.register(
      async (instance) => sendController(instance, { messageRouter: deps.messageRouter }),
    );

    await authenticated.register(
      async (instance) => statusController(instance, {
        accountRepository: deps.accountRepository,
        providerRegistry: deps.providerRegistry,
      }),
    );

    await authenticated.register(
      async (instance) => webhookConfigController(instance, {
        accountRepository: deps.accountRepository,
        webhookConfigRepo: deps.webhookConfigRepo,
      }),
    );

    await authenticated.register(
      async (instance) => groupsController(instance, {
        accountRepository: deps.accountRepository,
        providerRegistry: deps.providerRegistry,
      }),
    );

    // Messages query API (only when persistence is enabled)
    if (deps.messageStore) {
      const { messagesController } = await import('../connections/api/messages.controller.js');
      await authenticated.register(
        async (instance) => messagesController(instance, {
          messageStore: deps.messageStore!,
        }),
      );
    }
  });

  // ── WebSocket (token-based auth handled inside controller) ──

  if (deps.wsBroadcaster) {
    await fastify.register(
      async (instance) => websocketController(instance, {
        wsBroadcaster: deps.wsBroadcaster!,
        apiKey: deps.apiKey,
      }),
    );
  }

  return fastify;
}
