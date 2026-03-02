import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import type { ChannelAccountRepository } from '../domain/accounts/channel-account.repository.js';
import type { WebhookConfigRepository } from '../domain/webhooks/webhook-config.repository.js';
import type { MessageRouterService } from '../domain/routing/message-router.service.js';
import type { AdapterFactory } from '../adapters/adapter.factory.js';
import type { WebhookForwarder } from './webhook-forwarder.js';
import type { CredentialValidator } from './credential-validator.js';
import type { HealthCheckScheduler } from './health-check-scheduler.js';
import type { ConnectionManagerRegistry } from './connection-manager.registry.js';
import { healthController } from './api/health/health.controller.js';
import { accountsController } from './api/accounts/accounts.controller.js';
import { sendController } from './api/messaging/send.controller.js';
import { statusController } from './api/messaging/status.controller.js';
import { whatsappWebhookController } from './api/webhooks/whatsapp-webhook.controller.js';
import { telegramWebhookController } from './api/webhooks/telegram-webhook.controller.js';
import { emailWebhookController } from './api/webhooks/email-webhook.controller.js';
import { smsWebhookController } from './api/webhooks/sms-webhook.controller.js';
import { webhookConfigController } from './api/webhooks/webhook-config.controller.js';

export interface ServerDeps {
  accountRepository: ChannelAccountRepository;
  webhookConfigRepo: WebhookConfigRepository;
  messageRouter: MessageRouterService;
  adapterFactory: AdapterFactory;
  credentialValidator: CredentialValidator;
  healthCheckScheduler?: HealthCheckScheduler;
  connectionManagerRegistry: ConnectionManagerRegistry;
  webhookForwarder: WebhookForwarder;
  port: number;
  logLevel: string;
}

export async function createServer(deps: ServerDeps) {
  const isDev = process.env['NODE_ENV'] !== 'production';

  const fastify = Fastify({
    logger: isDev
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

  // CORS — allow external tools to consume the API and OpenAPI spec
  await fastify.register(fastifyCors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });

  // OpenAPI / Swagger
  await fastify.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Unified Messaging Gateway',
        description:
          'Single point of contact for all messaging integrations. ' +
          'Abstracts WhatsApp, Telegram, Email, and SMS providers behind a unified API.',
        version: '1.0.0',
      },
      tags: [
        { name: 'Health', description: 'Health check endpoints' },
        { name: 'Accounts', description: 'Account management and status' },
        { name: 'Messaging', description: 'Unified message sending API' },
        { name: 'Webhooks', description: 'Inbound message webhooks from providers' },
        { name: 'Webhooks Config', description: 'Per-account webhook configuration management' },
      ],
    },
  });

  await fastify.register(fastifySwaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
  });

  // OpenAPI spec at a well-known path (easier for external tooling)
  fastify.get('/openapi.json', {
    schema: { hide: true },
  }, async (_request, reply) => {
    return reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('cache-control', 'public, max-age=300')
      .send(fastify.swagger());
  });

  // Health
  await fastify.register(healthController);

  // Accounts (includes connection management: connect, pair, disconnect)
  await fastify.register(
    async (instance) => accountsController(instance, {
      accountRepository: deps.accountRepository,
      credentialValidator: deps.credentialValidator,
      healthCheckScheduler: deps.healthCheckScheduler,
      connectionManagerRegistry: deps.connectionManagerRegistry,
    }),
  );

  // Messaging (send / status)
  await fastify.register(
    async (instance) => sendController(instance, {
      messageRouter: deps.messageRouter,
    }),
  );

  await fastify.register(
    async (instance) => statusController(instance, {
      accountRepository: deps.accountRepository,
      adapterFactory: deps.adapterFactory,
    }),
  );

  // Webhooks
  await fastify.register(
    async (instance) => whatsappWebhookController(instance, {
      accountRepository: deps.accountRepository,
      webhookForwarder: deps.webhookForwarder,
    }),
  );

  await fastify.register(
    async (instance) => telegramWebhookController(instance, {
      accountRepository: deps.accountRepository,
      webhookForwarder: deps.webhookForwarder,
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

  // Webhook config management
  await fastify.register(
    async (instance) => webhookConfigController(instance, {
      accountRepository: deps.accountRepository,
      webhookConfigRepo: deps.webhookConfigRepo,
    }),
  );

  return fastify;
}
