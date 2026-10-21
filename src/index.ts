import { resolve } from 'node:path';
import { setGlobalLogger, getLogger } from './core/logger/logger.port.js';
import { createPinoLogger } from './infrastructure/logger/pino-logger.js';
import { DomainError } from './core/errors.js';
import { loadEnvConfig, resolveProviderCredential } from './infrastructure/config/env.config.js';
import { loadAccountsFromYaml } from './infrastructure/config/accounts.loader.js';
import { InMemoryAccountRepository } from './infrastructure/config/in-memory-account.repository.js';
import { ProviderRegistry } from './integrations/provider-registry.js';
import { baileysProvider, resolveBaileysLidToPhone } from './integrations/whatsapp/baileys/index.js';
import { wwebjsProvider } from './integrations/whatsapp/wwebjs-api/index.js';
import { telegramBotProvider } from './integrations/telegram/bot-api/index.js';
import { brevoProvider } from './integrations/email/brevo/index.js';
import { twilioProvider } from './integrations/sms/twilio/index.js';
import { messagebirdProvider } from './integrations/sms/messagebird/index.js';
import { MessageRouterService } from './core/routing/message-router.service.js';
import { EventBus } from './core/event-bus.js';
import { InboundPipeline } from './core/inbound/inbound-pipeline.js';
import { DiskMediaService, noopMediaService, type MediaService } from './core/inbound/media-service.js';
import { toStorableRaw, restoreBaileysRaw } from './integrations/whatsapp/baileys/baileys-storable-raw.js';
import { downloadBaileysMedia } from './integrations/whatsapp/baileys/baileys-media.js';
import { DiskMediaStore } from './persistence/media/disk-media-store.js';
import { startRetentionSchedule, type RetentionSchedule } from './core/retention/retention-job.js';
import { noopMetrics } from './core/metrics/metrics.port.js';
import type { FullMessageStorePort } from './core/persistence/message-store.port.js';
import { Events, createEvent } from './core/events.js';
import type { MessageInboundPayload, ConnectionUpdatePayload, MessageSendRequestPayload, MessageSendSuccessPayload, MessageSendFailurePayload } from './core/events.js';
import { messagesTotal, connectionStatus } from './infrastructure/metrics/prometheus.js';
import { WebhookForwarder } from './connections/webhooks/webhook-forwarder.js';
import { subscribeConnectionAlerts } from './connections/webhooks/connection-alert.subscriber.js';
import { FileWebhookConfigStore } from './connections/webhooks/file-webhook-config.store.js';
import { WebSocketBroadcaster } from './connections/ws/websocket-broadcaster.js';
import { CredentialValidator } from './infrastructure/credential-validator.js';
import { HealthCheckScheduler } from './infrastructure/health-check-scheduler.js';
import { createServer } from './infrastructure/server.js';
import type { ChannelAccount } from './core/accounts/channel-account.js';

/** Register all supported providers and inject the credential resolver */
function createProviderRegistry(): ProviderRegistry {
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(baileysProvider);
  providerRegistry.register(wwebjsProvider);
  providerRegistry.register(telegramBotProvider);
  providerRegistry.register(brevoProvider);
  providerRegistry.register(twilioProvider);
  providerRegistry.register(messagebirdProvider);
  providerRegistry.setCredentialResolver(resolveProviderCredential);

  const logger = getLogger();
  logger.info('Provider registry initialized', {
    count: providerRegistry.listProviders().length,
    providers: providerRegistry.listProviders().map((p) => p.id),
  });
  return providerRegistry;
}

/** Subscribe event handlers to the event bus */
function wireEventBus(
  eventBus: EventBus,
  webhookForwarder: WebhookForwarder,
  accountRepository: InMemoryAccountRepository,
  messageRouter: MessageRouterService,
): WebSocketBroadcaster {
  eventBus.on<MessageInboundPayload>(Events.MESSAGE_INBOUND, async (event) => {
    const env = event.data.envelope;
    messagesTotal.inc({
      direction: 'inbound',
      channel: env.channel,
      account: env.accountId,
      content_type: env.content.type,
    });
    await webhookForwarder.forward(env);
  });

  eventBus.on<ConnectionUpdatePayload>(Events.CONNECTION_UPDATE, async (event) => {
    const { accountId, status } = event.data;
    if (!accountId) return;
    const account = await accountRepository.findById(accountId);
    if (!account) return;

    connectionStatus.set(
      { account: accountId, provider: account.provider },
      status === 'connected' ? 1 : 0,
    );

    const logger = getLogger();
    if (status === 'connected' && account.status !== 'active') {
      await accountRepository.update(accountId, { status: 'active' });
      logger.info('Status auto-updated to active (connected)', { accountId });
    } else if (status === 'auth_expired' && account.status !== 'auth_expired') {
      await accountRepository.update(accountId, { status: 'auth_expired' });
      logger.warn('Status auto-updated to auth_expired (session revoked)', { accountId });
    } else if (status === 'disconnected' && account.status === 'active') {
      await accountRepository.update(accountId, { status: 'auth_expired' });
      logger.info('Status auto-updated to auth_expired (disconnected)', { accountId });
    }
  });

  eventBus.on<MessageSendRequestPayload>(Events.MESSAGE_SEND_REQUEST, async (event) => {
    const { command, replyTo } = event.data;
    try {
      const result = await messageRouter.send(command);
      await eventBus.emit(
        createEvent<MessageSendSuccessPayload>(
          Events.MESSAGE_SEND_SUCCESS, 'router',
          { result, accountId: command.fromAccountId ?? '', replyTo },
          command.fromAccountId,
        ),
      );
    } catch (err) {
      await eventBus.emit(
        createEvent<MessageSendFailurePayload>(
          Events.MESSAGE_SEND_FAILURE, 'router',
          {
            error: err instanceof Error ? err.message : 'Send failed',
            code: err instanceof DomainError ? err.code : 'UNKNOWN',
            accountId: command.fromAccountId,
            replyTo,
          },
          command.fromAccountId,
        ),
      );
    }
  });

  eventBus.on<MessageSendSuccessPayload>(Events.MESSAGE_SEND_SUCCESS, async (event) => {
    const account = await accountRepository.findById(event.data.accountId);
    messagesTotal.inc({
      direction: 'outbound',
      channel: account?.channel ?? 'unknown',
      account: event.data.accountId,
      content_type: 'unknown',
    });
  });

  return new WebSocketBroadcaster(eventBus);
}

/** Connect managed providers (e.g. Baileys) and wire their inbound events */
async function connectManagedProviders(
  accounts: ChannelAccount[],
  providerRegistry: ProviderRegistry,
  eventBus: EventBus,
  inboundPipeline: InboundPipeline,
): Promise<void> {
  const logger = getLogger();
  const managedAccounts = accounts.filter(
    (a) => providerRegistry.get(a.provider)?.connection && (a.status === 'active' || a.status === 'unchecked' || a.status === 'auth_expired'),
  );

  for (const account of managedAccounts) {
    const bundle = providerRegistry.getOrThrow(account.provider);
    try {
      const connectionManager = bundle.connection!();
      await connectionManager.connect(account.id, account.providerConfig);

      if (bundle.wireEvents) {
        await bundle.wireEvents(account, eventBus, inboundPipeline);
      }

      logger.info('Connected and listening for messages', { provider: account.provider, accountId: account.id });
    } catch (err) {
      logger.error('Failed to connect', { provider: account.provider, accountId: account.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

async function main() {
  const envConfig = loadEnvConfig();
  setGlobalLogger(createPinoLogger({
    level: envConfig.logLevel,
    pretty: envConfig.nodeEnv === 'development',
  }));
  const logger = getLogger();
  const yamlPath = envConfig.accountsConfigPath ?? resolve(process.cwd(), 'data/accounts.yaml');
  const rawAccounts = loadAccountsFromYaml(yamlPath);

  const eventBus = new EventBus();
  const providerRegistry = createProviderRegistry();

  // Validate credentials
  const credentialValidator = new CredentialValidator(providerRegistry);
  logger.info('Loaded accounts from configuration, validating credentials', { count: rawAccounts.length });
  const accounts = await credentialValidator.validateAll(rawAccounts);

  const counts = { active: 0, auth_expired: 0, unchecked: 0, error: 0 };
  for (const a of accounts) counts[a.status as keyof typeof counts]++;
  logger.info('Validation complete', counts);

  // Core services
  const accountRepository = new InMemoryAccountRepository(accounts, yamlPath);
  const messageRouter = new MessageRouterService(accountRepository, providerRegistry, eventBus);
  const webhookConfigRepo = await FileWebhookConfigStore.create(resolve(process.cwd(), 'data/webhooks.json'));
  const webhookForwarder = new WebhookForwarder(webhookConfigRepo, envConfig.webhookCallbackUrl, envConfig.webhookCallbackSecret);

  const webhookConfigs = await webhookConfigRepo.findAll();
  logger.info('Loaded per-account webhook configs', { count: webhookConfigs.length });

  // Wire event bus
  const wsBroadcaster = wireEventBus(eventBus, webhookForwarder, accountRepository, messageRouter);
  subscribeConnectionAlerts(eventBus, webhookForwarder, envConfig.alertWebhookUrl);

  // Optional: persistence plugin (SQLite or PostgreSQL)
  let messageStore: FullMessageStorePort | undefined;
  if (envConfig.storageEnabled) {
    const { createMessageStore } = await import('./persistence/message-store.factory.js');
    const { subscribePersistence } = await import('./persistence/persistence-subscriber.js');
    messageStore = await createMessageStore(envConfig);
    subscribePersistence(eventBus, messageStore);
    logger.info('Persistence enabled', {
      driver: envConfig.storageDriver,
      ...(envConfig.storageDriver === 'sqlite' ? { database: envConfig.databasePath } : {}),
    });
  }

  // Inbound media goes to disk (never to the database); without a message log there is nowhere to record it.
  const mediaStore = new DiskMediaStore(envConfig.mediaDir);
  const mediaService: MediaService = messageStore
    ? new DiskMediaService({
        store: messageStore,
        files: mediaStore,
        download: (raw, maxBytes) => downloadBaileysMedia(raw as Parameters<typeof downloadBaileysMedia>[0], maxBytes),
        restoreRaw: restoreBaileysRaw,
        maxBytes: envConfig.mediaMaxBytes,
      })
    : noopMediaService;

  // Inbound: filter → persist (message log) → emit → media. Persisting strictly
  // before emitting keeps `accountSeq` gaps meaningful for consumers.
  const inboundPipeline = new InboundPipeline({
    store: messageStore,
    eventBus,
    media: mediaService,
    metrics: noopMetrics,
    resolveLidToPhone: resolveBaileysLidToPhone,
    toStorableRaw,
  });

  // Health check scheduler
  const healthCheckScheduler = new HealthCheckScheduler(
    accountRepository, credentialValidator, { intervalMs: envConfig.healthCheckIntervalMs },
  );

  // Server
  const server = await createServer({
    accountRepository, webhookConfigRepo, providerRegistry,
    messageRouter, credentialValidator, healthCheckScheduler,
    webhookForwarder, wsBroadcaster, messageStore, mediaStore,
    apiKey: envConfig.apiKey,
    port: envConfig.port, logLevel: envConfig.logLevel,
    metricsEnabled: envConfig.metricsEnabled,
  });

  try {
    await server.listen({ port: envConfig.port, host: '0.0.0.0' });
    logger.info('Unified Messaging Gateway listening', { port: envConfig.port });
    logger.info('Swagger UI available', { url: `http://localhost:${envConfig.port}/docs` });

    await connectManagedProviders(accounts, providerRegistry, eventBus, inboundPipeline);
    // Media left pending by a previous run (crash between persisting the message and downloading it).
    mediaService.resumePendingMedia().catch((err) => {
      logger.error('Failed to resume pending media', { error: err instanceof Error ? err.message : String(err) });
    });
    healthCheckScheduler.start();

    // Daily retention (also once now, off the startup path). Needs the message log: without it nothing is stored.
    let retention: RetentionSchedule | undefined;
    if (messageStore) {
      logger.info('Retention schedule started', {
        mediaRetentionDays: envConfig.mediaRetentionDays || 'disabled',
        messageRetentionDays: envConfig.messageRetentionDays || 'disabled',
      });
      retention = startRetentionSchedule({
        messages: messageStore,
        media: mediaStore,
        mediaRetentionDays: envConfig.mediaRetentionDays,
        messageRetentionDays: envConfig.messageRetentionDays,
      });
    }

    const shutdown = async () => {
      logger.info('Shutting down gracefully...');
      retention?.stop();
      healthCheckScheduler.stop();
      await server.close();
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

process.on('unhandledRejection', (err) => {
  getLogger().error('Unhandled rejection', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});

main().catch((err) => {
  getLogger().error('Fatal startup error', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
