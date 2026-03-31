import { resolve } from 'node:path';
import { loadEnvConfig } from './infrastructure/config/env.config.js';
import { loadAccountsFromYaml } from './infrastructure/config/accounts.loader.js';
import { InMemoryAccountRepository } from './infrastructure/config/in-memory-account.repository.js';
import { AdapterFactory } from './integrations/adapter.factory.js';
import { HealthCheckerRegistry } from './integrations/health-checker.registry.js';
import { WwebjsApiAdapter } from './integrations/whatsapp/wwebjs-api/wwebjs.adapter.js';
import { WwebjsHealthChecker } from './integrations/whatsapp/wwebjs-api/wwebjs.health-checker.js';
import { BaileysAdapter } from './integrations/whatsapp/baileys/baileys.adapter.js';
import { BaileysHealthChecker } from './integrations/whatsapp/baileys/baileys.health-checker.js';
import { BaileysConnectionManager } from './integrations/whatsapp/baileys/baileys.connection-manager.js';
import { baileysSocketManager } from './integrations/whatsapp/baileys/baileys-socket.manager.js';
import { BaileysWebhookAdapter } from './integrations/whatsapp/baileys/baileys-webhook.adapter.js';
import { mapBaileysToWhatsAppEvent } from './integrations/whatsapp/baileys/baileys.mapper.js';
import { parseBaileysConfig } from './integrations/whatsapp/baileys/baileys.types.js';
import { TelegramBotHealthChecker } from './integrations/telegram/bot-api/telegram-bot.health-checker.js';
import { BrevoHealthChecker } from './integrations/email/brevo/brevo.health-checker.js';
import { TwilioHealthChecker } from './integrations/sms/twilio/twilio.health-checker.js';
import { MessageBirdHealthChecker } from './integrations/sms/messagebird/messagebird.health-checker.js';
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

  // 3. Register health checkers per provider
  const healthCheckerRegistry = new HealthCheckerRegistry();
  healthCheckerRegistry.register('wwebjs-api', new WwebjsHealthChecker());
  healthCheckerRegistry.register('telegram-bot-api', new TelegramBotHealthChecker());
  healthCheckerRegistry.register('brevo', new BrevoHealthChecker());
  healthCheckerRegistry.register('twilio', new TwilioHealthChecker());
  healthCheckerRegistry.register('messagebird', new MessageBirdHealthChecker());
  healthCheckerRegistry.register('baileys', new BaileysHealthChecker());

  // 4. Validate credentials against real provider APIs
  const credentialValidator = new CredentialValidator(healthCheckerRegistry);
  console.log(`Loaded ${rawAccounts.length} account(s) from configuration, validating credentials...`);
  const accounts = await credentialValidator.validateAll(rawAccounts);

  const active = accounts.filter((a) => a.status === 'active').length;
  const authExpired = accounts.filter((a) => a.status === 'auth_expired').length;
  const unchecked = accounts.filter((a) => a.status === 'unchecked').length;
  const errored = accounts.filter((a) => a.status === 'error').length;
  console.log(`Validation complete: ${active} active, ${authExpired} auth_expired, ${unchecked} unchecked, ${errored} error`);

  // 5. Create repository (with persistence back to YAML)
  const accountsYamlPath = envConfig.accountsConfigPath ?? resolve(process.cwd(), 'data/accounts.yaml');
  const accountRepository = new InMemoryAccountRepository(accounts, accountsYamlPath);

  // 6. Create adapter factory and register adapters
  const adapterFactory = new AdapterFactory();
  adapterFactory.register('wwebjs-api', WwebjsApiAdapter);
  adapterFactory.register('baileys', BaileysAdapter);

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

  // 9. Create connection manager registry
  const connectionManagerRegistry = new ConnectionManagerRegistry();
  connectionManagerRegistry.register(new BaileysConnectionManager());

  // 10. Create health check scheduler
  const healthCheckIntervalMs = parseInt(process.env['HEALTH_CHECK_INTERVAL_MS'] ?? '300000', 10);
  const healthCheckScheduler = new HealthCheckScheduler(
    accountRepository,
    credentialValidator,
    { intervalMs: healthCheckIntervalMs },
  );

  // 11. Create and start server
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

    // Connect Baileys accounts and register inbound message handlers
    const baileysAccounts = accounts.filter(
      (a) => a.provider === 'baileys' && (a.status === 'active' || a.status === 'unchecked' || a.status === 'auth_expired'),
    );

    for (const account of baileysAccounts) {
      const config = parseBaileysConfig(account.providerConfig);
      try {
        await baileysSocketManager.connect(account.id, config);
        const baileysWebhookAdapter = new BaileysWebhookAdapter();

        // Inbound messages → emit to event bus
        baileysSocketManager.onMessage(account.id, async (event) => {
          for (const msg of event.messages) {
            if (msg.key?.fromMe) continue;
            try {
              const waEvent = mapBaileysToWhatsAppEvent(msg);
              const envelope = baileysWebhookAdapter.toEnvelope(waEvent, account);
              await eventBus.emit(
                createEvent<MessageInboundPayload>(
                  Events.MESSAGE_INBOUND,
                  'baileys',
                  { envelope },
                  account.id,
                ),
              );
            } catch (err) {
              console.error(`[baileys:${account.id}] Failed to process inbound message:`, err);
            }
          }
        });

        // Connection updates → emit to event bus
        baileysSocketManager.onConnectionUpdate(account.id, (update) => {
          const status = baileysSocketManager.getConnectionStatus(account.id);
          const qr = update.qr ?? baileysSocketManager.getLastQr(account.id);
          void eventBus.emit(
            createEvent<ConnectionUpdatePayload>(
              Events.CONNECTION_UPDATE,
              'baileys',
              { accountId: account.id, status, qr },
              account.id,
            ),
          );
        });

        console.log(`[baileys:${account.id}] Connected and listening for messages`);
      } catch (err) {
        console.error(`[baileys:${account.id}] Failed to connect:`, err);
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
