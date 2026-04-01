import { resolve } from 'node:path';
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
import { baileysSocketManager } from './integrations/whatsapp/baileys/baileys-socket.manager.js';
import { mapBaileysToWhatsAppEvent } from './integrations/whatsapp/baileys/baileys.mapper.js';
import { parseBaileysConfig } from './integrations/whatsapp/baileys/baileys.types.js';
import { HealthCheckerRegistry } from './integrations/health-checker.registry.js';
import { AdapterFactory } from './integrations/adapter.factory.js';
import { MessageRouterService } from './core/routing/message-router.service.js';
import { EventBus } from './core/event-bus.js';
import { Events, createEvent } from './core/events.js';
import type { MessageInboundPayload, ConnectionUpdatePayload } from './core/events.js';
import { WebhookForwarder } from './connections/webhooks/webhook-forwarder.js';
import { FileWebhookConfigStore } from './connections/webhooks/file-webhook-config.store.js';
import { CredentialValidator } from './infrastructure/credential-validator.js';
import { HealthCheckScheduler } from './infrastructure/health-check-scheduler.js';
import { ConnectionManagerRegistry } from './infrastructure/connection-manager.registry.js';
import { createServer } from './infrastructure/server.js';

async function main() {
  // 1. Load configuration
  const envConfig = loadEnvConfig();
  const rawAccounts = loadAccountsFromYaml(envConfig.accountsConfigPath);

  // 2. Create Event Bus (backbone of the system)
  const eventBus = new EventBus();

  // 3. Register all providers via ProviderRegistry
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(baileysProvider);
  providerRegistry.register(wwebjsProvider);
  providerRegistry.register(telegramBotProvider);
  providerRegistry.register(brevoProvider);
  providerRegistry.register(twilioProvider);
  providerRegistry.register(messagebirdProvider);

  console.log(`Registered ${providerRegistry.listProviders().length} provider(s): ${providerRegistry.listProviders().map((p) => p.id).join(', ')}`);

  // 4. Build legacy registries from ProviderRegistry (backwards compat for existing code)
  const healthCheckerRegistry = new HealthCheckerRegistry();
  const adapterFactory = new AdapterFactory();
  const connectionManagerRegistry = new ConnectionManagerRegistry();

  for (const info of providerRegistry.listProviders()) {
    const bundle = providerRegistry.getOrThrow(info.id);
    if (bundle.health) healthCheckerRegistry.register(info.id, bundle.health());
    if (bundle.connection) connectionManagerRegistry.register(bundle.connection());
    // Register messaging adapter constructor for AdapterFactory compatibility
    const messagingFactory = bundle.messaging;
    adapterFactory.register(info.id, class {
      constructor(
        providerConfig: Record<string, unknown>,
        credentialsRef: string,
        inlineCredential?: string,
      ) {
        return messagingFactory(providerConfig, credentialsRef, inlineCredential) as any;
      }
    } as any);
  }

  // 5. Validate credentials against real provider APIs
  const credentialValidator = new CredentialValidator(healthCheckerRegistry);
  console.log(`Loaded ${rawAccounts.length} account(s) from configuration, validating credentials...`);
  const accounts = await credentialValidator.validateAll(rawAccounts);

  const active = accounts.filter((a) => a.status === 'active').length;
  const authExpired = accounts.filter((a) => a.status === 'auth_expired').length;
  const unchecked = accounts.filter((a) => a.status === 'unchecked').length;
  const errored = accounts.filter((a) => a.status === 'error').length;
  console.log(`Validation complete: ${active} active, ${authExpired} auth_expired, ${unchecked} unchecked, ${errored} error`);

  // 6. Create repository (with persistence back to YAML)
  const accountsYamlPath = envConfig.accountsConfigPath ?? resolve(process.cwd(), 'data/accounts.yaml');
  const accountRepository = new InMemoryAccountRepository(accounts, accountsYamlPath);

  // 7. Create services
  const messageRouter = new MessageRouterService(accountRepository, adapterFactory);
  const webhookConfigRepo = new FileWebhookConfigStore(
    resolve(process.cwd(), 'data/webhooks.json'),
  );
  const webhookForwarder = new WebhookForwarder(
    webhookConfigRepo,
    envConfig.webhookCallbackUrl,
    envConfig.webhookCallbackSecret,
  );

  const webhookConfigs = await webhookConfigRepo.findAll();
  console.log(`Loaded ${webhookConfigs.length} per-account webhook config(s)`);

  // 8. Subscribe WebhookForwarder to event bus
  eventBus.on<MessageInboundPayload>(Events.MESSAGE_INBOUND, async (event) => {
    await webhookForwarder.forward(event.data.envelope);
  });

  // 9. Create health check scheduler
  const healthCheckIntervalMs = parseInt(process.env['HEALTH_CHECK_INTERVAL_MS'] ?? '300000', 10);
  const healthCheckScheduler = new HealthCheckScheduler(
    accountRepository,
    credentialValidator,
    { intervalMs: healthCheckIntervalMs },
  );

  // 10. Create and start server
  const server = await createServer({
    accountRepository,
    webhookConfigRepo,
    messageRouter,
    adapterFactory,
    credentialValidator,
    healthCheckScheduler,
    connectionManagerRegistry,
    webhookForwarder,
    port: envConfig.port,
    logLevel: envConfig.logLevel,
  });

  try {
    await server.listen({ port: envConfig.port, host: '0.0.0.0' });
    console.log(`Unified Messaging Gateway listening on port ${envConfig.port}`);
    console.log(`Swagger UI available at http://localhost:${envConfig.port}/docs`);

    // Connect managed providers (Baileys) and wire inbound events
    const managedAccounts = accounts.filter(
      (a) => providerRegistry.get(a.provider)?.connection && (a.status === 'active' || a.status === 'unchecked' || a.status === 'auth_expired'),
    );

    for (const account of managedAccounts) {
      const bundle = providerRegistry.getOrThrow(account.provider);
      const inboundAdapter = bundle.inbound?.();

      if (account.provider === 'baileys') {
        // Baileys-specific: connect socket and wire message handler
        const config = parseBaileysConfig(account.providerConfig);
        try {
          await baileysSocketManager.connect(account.id, config);

          if (inboundAdapter) {
            baileysSocketManager.onMessage(account.id, async (event) => {
              for (const msg of event.messages) {
                if (msg.key?.fromMe) continue;
                try {
                  const waEvent = mapBaileysToWhatsAppEvent(msg);
                  const envelope = inboundAdapter.toEnvelope(waEvent, account);
                  await eventBus.emit(
                    createEvent<MessageInboundPayload>(
                      Events.MESSAGE_INBOUND,
                      account.provider,
                      { envelope },
                      account.id,
                    ),
                  );
                } catch (err) {
                  console.error(`[${account.provider}:${account.id}] Failed to process inbound message:`, err);
                }
              }
            });
          }

          // Connection updates → emit to event bus
          baileysSocketManager.onConnectionUpdate(account.id, (update) => {
            const status = baileysSocketManager.getConnectionStatus(account.id);
            const qr = update.qr ?? baileysSocketManager.getLastQr(account.id);
            void eventBus.emit(
              createEvent<ConnectionUpdatePayload>(
                Events.CONNECTION_UPDATE,
                account.provider,
                { accountId: account.id, status, qr },
                account.id,
              ),
            );
          });

          console.log(`[${account.provider}:${account.id}] Connected and listening for messages`);
        } catch (err) {
          console.error(`[${account.provider}:${account.id}] Failed to connect:`, err);
        }
      }
    }

    // Start periodic health checks after server is ready
    healthCheckScheduler.start();
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

main();
