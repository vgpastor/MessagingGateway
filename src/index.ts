import { resolve } from 'node:path';
import { DomainError } from './core/errors.js';
import { loadEnvConfig } from './infrastructure/config/env.config.js';
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
import type { MessageInboundPayload, MessageSendRequestPayload, MessageSendSuccessPayload, MessageSendFailurePayload } from './core/events.js';
import { WebhookForwarder } from './connections/webhooks/webhook-forwarder.js';
import { FileWebhookConfigStore } from './connections/webhooks/file-webhook-config.store.js';
import { WebSocketBroadcaster } from './connections/ws/websocket-broadcaster.js';
import { CredentialValidator } from './infrastructure/credential-validator.js';
import { HealthCheckScheduler } from './infrastructure/health-check-scheduler.js';
import { createServer } from './infrastructure/server.js';

async function main() {
  const envConfig = loadEnvConfig();
  const yamlPath = envConfig.accountsConfigPath ?? resolve(process.cwd(), 'data/accounts.yaml');
  const rawAccounts = loadAccountsFromYaml(yamlPath);

  // Event Bus — backbone of inter-domain communication
  const eventBus = new EventBus();

  // Provider Registry — single place to register all providers
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(baileysProvider);
  providerRegistry.register(wwebjsProvider);
  providerRegistry.register(telegramBotProvider);
  providerRegistry.register(brevoProvider);
  providerRegistry.register(twilioProvider);
  providerRegistry.register(messagebirdProvider);

  console.log(`Registered ${providerRegistry.listProviders().length} provider(s): ${providerRegistry.listProviders().map((p) => p.id).join(', ')}`);

  // Validate credentials
  const credentialValidator = new CredentialValidator(providerRegistry);
  console.log(`Loaded ${rawAccounts.length} account(s) from configuration, validating credentials...`);
  const accounts = await credentialValidator.validateAll(rawAccounts);

  const counts = { active: 0, auth_expired: 0, unchecked: 0, error: 0 };
  for (const a of accounts) counts[a.status as keyof typeof counts]++;
  console.log(`Validation complete: ${counts.active} active, ${counts.auth_expired} auth_expired, ${counts.unchecked} unchecked, ${counts.error} error`);

  // Repository
  const accountRepository = new InMemoryAccountRepository(accounts, yamlPath);

  // Core services
  const messageRouter = new MessageRouterService(accountRepository, providerRegistry);
  const webhookConfigRepo = new FileWebhookConfigStore(resolve(process.cwd(), 'data/webhooks.json'));
  const webhookForwarder = new WebhookForwarder(webhookConfigRepo, envConfig.webhookCallbackUrl, envConfig.webhookCallbackSecret);

  const webhookConfigs = await webhookConfigRepo.findAll();
  console.log(`Loaded ${webhookConfigs.length} per-account webhook config(s)`);

  // Subscribe connections to event bus
  eventBus.on<MessageInboundPayload>(Events.MESSAGE_INBOUND, async (event) => {
    await webhookForwarder.forward(event.data.envelope);
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

  const wsBroadcaster = new WebSocketBroadcaster(eventBus);

  // Health check scheduler
  const healthCheckIntervalMs = envConfig.healthCheckIntervalMs;
  const healthCheckScheduler = new HealthCheckScheduler(
    accountRepository, credentialValidator, { intervalMs: healthCheckIntervalMs },
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
    console.log(`Unified Messaging Gateway listening on port ${envConfig.port}`);
    console.log(`Swagger UI available at http://localhost:${envConfig.port}/docs`);

    // Connect managed providers and wire inbound events — NO provider-specific code here
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

        console.log(`[${account.provider}:${account.id}] Connected and listening for messages`);
      } catch (err) {
        console.error(`[${account.provider}:${account.id}] Failed to connect:`, err);
      }
    }

    healthCheckScheduler.start();
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  process.exit(1);
});

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
