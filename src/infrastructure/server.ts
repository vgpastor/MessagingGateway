import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify, { LogController, type FastifyRequest } from 'fastify';
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
import type { CredentialValidatorPort } from '../core/accounts/credential-validator.port.js';
import type { HealthCheckSchedulerPort } from '../core/accounts/health-check-scheduler.port.js';
import type { WebSocketBroadcaster } from '../connections/ws/websocket-broadcaster.js';
import { createApiKeyGuard, type AuthScope } from '../core/auth/api-key.guard.js';
import { redactUrl } from './logging/redact-url.js';
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
import { websocketController, selectKeyProtocol } from '../connections/ws/websocket.controller.js';
import { metricsController } from '../connections/api/metrics.controller.js';
import { accountSchema } from './config/accounts.schema.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Scope granted by the API key guard (`admin` or `read`). */
    authScope?: AuthScope;
  }
}

export interface ServerDeps {
  accountRepository: ChannelAccountRepository;
  webhookConfigRepo: WebhookConfigRepository;
  providerRegistry: ProviderLookupPort;
  messageRouter: MessageRouterService;
  credentialValidator: CredentialValidatorPort;
  healthCheckScheduler?: HealthCheckSchedulerPort;
  /** Wires an account's inbound events (idempotent); used for accounts created or connected at runtime. */
  wireAccount?: (account: import('../core/accounts/channel-account.js').ChannelAccount) => Promise<void>;
  webhookForwarder: WebhookForwarder;
  wsBroadcaster?: WebSocketBroadcaster;
  messageStore?: import('../core/persistence/message-store.port.js').FullMessageStorePort;
  /** Where inbound media is read from; enables GET /api/v1/media/:id together with `messageStore`. */
  mediaStore?: import('../core/inbound/media-service.js').MediaFileReader;
  apiKey: string;
  /** Optional read-only key: GET messages/media and the WS event stream, nothing else. */
  readApiKey?: string;
  port: number;
  logLevel: string;
  /** Where the structured logs are written (defaults to stdout); mainly for tests. */
  logStream?: { write(msg: string): void };
  metricsEnabled?: boolean;
}

export async function createServer(deps: ServerDeps) {
  const isDev = process.env['NODE_ENV'] !== 'production';
  const usePrettyLogs = process.env['NODE_ENV'] === 'development';

  // Same shape as Fastify's default request serializer, with the token query value redacted.
  const serializers = {
    req: (request: FastifyRequest) => ({
      method: request.method,
      url: redactUrl(request.url),
      host: request.host,
      remoteAddress: request.ip,
      remotePort: request.socket?.remotePort,
    }),
  };

  const fastify = Fastify({
    // Fastify's own request logs print the raw URL; the onResponse hook below logs a redacted one.
    logController: new LogController({ disableRequestLogging: true }),
    logger: usePrettyLogs
      ? {
          level: deps.logLevel,
          serializers,
          transport: {
            target: 'pino-pretty',
            options: { colorize: true },
          },
        }
      : {
          level: deps.logLevel,
          serializers,
          ...(deps.logStream ? { stream: deps.logStream } : {}),
        },
  });

  fastify.addHook('onResponse', async (request, reply) => {
    if (request.url.split('?')[0] === '/health') return;
    const fields = {
      method: request.method,
      url: redactUrl(request.url),
      route: request.routeOptions?.url,
      statusCode: reply.statusCode,
      responseTime: Math.round(reply.elapsedTime * 100) / 100,
    };
    if (reply.statusCode >= 500) request.log.error(fields, 'request completed');
    else request.log.info(fields, 'request completed');
  });

  // Request logging is off, so handler errors would go unreported: log them here (no URL, no query).
  fastify.addHook('onError', async (request, _reply, error) => {
    request.log.error(
      { err: error, method: request.method, route: request.routeOptions?.url },
      'request errored',
    );
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

  // The key can travel as the `umg.<key>` subprotocol; it must be echoed back in the handshake.
  await fastify.register(fastifyWebsocket, { options: { handleProtocols: selectKeyProtocol } });

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

  const apiKeyGuard = createApiKeyGuard({ adminKey: deps.apiKey, readKey: deps.readApiKey });

  await fastify.register(async (authenticated) => {
    authenticated.addHook('preHandler', apiKeyGuard);

    // Prometheus metrics: admin key only (the read-only key gets 403).
    if (deps.metricsEnabled !== false) {
      const { registry } = await import('./metrics/prometheus.js');
      await authenticated.register(
        async (instance) => metricsController(instance, {
          getMetrics: () => registry.metrics(),
          contentType: registry.contentType,
        }),
      );
    }

    await authenticated.register(
      async (instance) => accountsController(instance, {
        accountRepository: deps.accountRepository,
        credentialValidator: deps.credentialValidator,
        healthCheckScheduler: deps.healthCheckScheduler,
        providerRegistry: deps.providerRegistry,
        wireAccount: deps.wireAccount,
        validateAccountBody: (body: unknown) => {
          const parsed = accountSchema.safeParse(body);
          if (!parsed.success) {
            return {
              success: false,
              error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
            };
          }
          return { success: true, data: parsed.data as import('../connections/api/accounts.controller.js').ValidatedAccountData };
        },
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
      const { ConversationContextService } = await import('../core/persistence/conversation-context.service.js');
      const contextService = new ConversationContextService(deps.messageStore);
      await authenticated.register(
        async (instance) => messagesController(instance, {
          messageStore: deps.messageStore!,
          contextService,
        }),
      );

      if (deps.mediaStore) {
        const { mediaController } = await import('../connections/api/media.controller.js');
        await authenticated.register(
          async (instance) => mediaController(instance, {
            messageStore: deps.messageStore!,
            mediaStore: deps.mediaStore!,
          }),
        );
      }
    }
  });

  // ── WebSocket (key auth handled inside the controller: header, subprotocol or legacy ?token=) ──

  if (deps.wsBroadcaster) {
    await fastify.register(
      async (instance) => websocketController(instance, {
        wsBroadcaster: deps.wsBroadcaster!,
        apiKey: deps.apiKey,
        readApiKey: deps.readApiKey,
      }),
    );
  }

  return fastify;
}
