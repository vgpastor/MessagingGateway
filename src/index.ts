import { resolve } from 'node:path';
import { setGlobalLogger, getLogger } from './core/logger/logger.port.js';
import { createPinoLogger } from './infrastructure/logger/pino-logger.js';
import { DomainError } from './core/errors.js';
import { loadEnvConfig, resolveProviderCredential } from './infrastructure/config/env.config.js';
import { loadAccountsFromYaml } from './infrastructure/config/accounts.loader.js';
import { InMemoryAccountRepository } from './infrastructure/config/in-memory-account.repository.js';
import { ProviderRegistry } from './integrations/provider-registry.js';
import { baileysProvider } from './integrations/whatsapp/baileys/index.js';
import { wwebjsProvider } from './integrations/whatsapp/wwebjs-api/index.js';
import { telegramBotProvider } from './integrations/telegram/bot-api/index.js';
import { brevoProvider } from './integrations/email/brevo/index.js';
import { twilioProvider } from './integrations/sms/twilio/index.js';
import { messagebirdProvider } from './integrations/sms/messagebird/index.js';
import { MessageRouterService } from './core/routing/message-router.service.js';
import { EventBus } from './core/event-bus.js';
import { Events, createEvent } from './core/events.js';
import type { MessageInboundPayload, ConnectionUpdatePayload, MessageSendRequestPayload, MessageSendSuccessPayload, MessageSendFailurePayload } from './core/events.js';
import { WebhookForwarder } from './connections/webhooks/webhook-forwarder.js';
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
    await webhookForwarder.forward(event.data.envelope);
  });

  eventBus.on<ConnectionUpdatePayload>(Events.CONNECTION_UPDATE, async (event) => {
    const { accountId, status } = event.data;
    if (!accountId) return;
    const account = await accountRepository.findById(accountId);
    if (!account) return;

    const logger = getLogger();
    if (status === 'connected' && account.status !== 'active') {
      await accountRepository.update(accountId, { status: 'active' });
      logger.info('Status auto-updated to active (connected)', { accountId });
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

  return new WebSocketBroadcaster(eventBus);
}

/** Connect managed providers (e.g. Baileys) and wire their inbound events */
async function connectManagedProviders(
  accounts: ChannelAccount[],
  providerRegistry: ProviderRegistry,
  eventBus: EventBus,
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
        await bundle.wireEvents(account, eventBus);
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
  const messageRouter = new MessageRouterService(accountRepository, providerRegistry);
  const webhookConfigRepo = await FileWebhookConfigStore.create(resolve(process.cwd(), 'data/webhooks.json'));
  const webhookForwarder = new WebhookForwarder(webhookConfigRepo, envConfig.webhookCallbackUrl, envConfig.webhookCallbackSecret);

  const webhookConfigs = await webhookConfigRepo.findAll();
  logger.info('Loaded per-account webhook configs', { count: webhookConfigs.length });

  // Wire event bus
  const wsBroadcaster = wireEventBus(eventBus, webhookForwarder, accountRepository, messageRouter);

  // Health check scheduler
  const healthCheckScheduler = new HealthCheckScheduler(
    accountRepository, credentialValidator, { intervalMs: envConfig.healthCheckIntervalMs },
  );

  // Server
  const server = await createServer({
    accountRepository, webhookConfigRepo, providerRegistry,
    messageRouter, credentialValidator, healthCheckScheduler,
    webhookForwarder, wsBroadcaster,
    apiKey: envConfig.apiKey,
    port: envConfig.port, logLevel: envConfig.logLevel,
  });

  try {
    await server.listen({ port: envConfig.port, host: '0.0.0.0' });
    logger.info('Unified Messaging Gateway listening', { port: envConfig.port });
    logger.info('Swagger UI available', { url: `http://localhost:${envConfig.port}/docs` });

    await connectManagedProviders(accounts, providerRegistry, eventBus);
    healthCheckScheduler.start();

    const shutdown = async () => {
      logger.info('Shutting down gracefully...');
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
