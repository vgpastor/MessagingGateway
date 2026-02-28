import Fastify from 'fastify';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import type { ChannelAccountRepository } from '../domain/accounts/channel-account.repository.js';
import type { MessageRouterService } from '../domain/routing/message-router.service.js';
import type { AdapterFactory } from '../adapters/adapter.factory.js';
import type { WebhookForwarder } from './webhook-forwarder.js';
import { healthController } from './api/health/health.controller.js';
import { accountsController } from './api/accounts/accounts.controller.js';
import { sendController } from './api/messaging/send.controller.js';
import { statusController } from './api/messaging/status.controller.js';
import { whatsappWebhookController } from './api/webhooks/whatsapp-webhook.controller.js';
import { telegramWebhookController } from './api/webhooks/telegram-webhook.controller.js';
import { emailWebhookController } from './api/webhooks/email-webhook.controller.js';
import { smsWebhookController } from './api/webhooks/sms-webhook.controller.js';

export interface ServerDeps {
  accountRepository: ChannelAccountRepository;
  messageRouter: MessageRouterService;
  adapterFactory: AdapterFactory;
  webhookForwarder: WebhookForwarder;
  port: number;
  logLevel: string;
}

export async function createServer(deps: ServerDeps) {
  const fastify = Fastify({
    logger: {
      level: deps.logLevel,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    },
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

  // Health
  await fastify.register(healthController);

  // Accounts
  await fastify.register(
    async (instance) => accountsController(instance, {
      accountRepository: deps.accountRepository,
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

  return fastify;
}
