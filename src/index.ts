import { resolve } from 'node:path';
import { loadEnvConfig } from './infrastructure/config/env.config.js';
import { loadAccountsFromYaml } from './infrastructure/config/accounts.loader.js';
import { InMemoryAccountRepository } from './infrastructure/config/in-memory-account.repository.js';
import { AdapterFactory } from './adapters/adapter.factory.js';
import { HealthCheckerRegistry } from './adapters/health-checker.registry.js';
import { WwebjsApiAdapter } from './adapters/whatsapp/wwebjs-api/wwebjs.adapter.js';
import { WwebjsHealthChecker } from './adapters/whatsapp/wwebjs-api/wwebjs.health-checker.js';
import { TelegramBotHealthChecker } from './adapters/telegram/bot-api/telegram-bot.health-checker.js';
import { BrevoHealthChecker } from './adapters/email/brevo/brevo.health-checker.js';
import { TwilioHealthChecker } from './adapters/sms/twilio/twilio.health-checker.js';
import { MessageBirdHealthChecker } from './adapters/sms/messagebird/messagebird.health-checker.js';
import { MessageRouterService } from './domain/routing/message-router.service.js';
import { WebhookForwarder } from './infrastructure/webhook-forwarder.js';
import { FileWebhookConfigStore } from './infrastructure/webhooks/file-webhook-config.store.js';
import { CredentialValidator } from './infrastructure/credential-validator.js';
import { HealthCheckScheduler } from './infrastructure/health-check-scheduler.js';
import { createServer } from './infrastructure/server.js';

async function main() {
  // 1. Load configuration
  const envConfig = loadEnvConfig();
  const rawAccounts = loadAccountsFromYaml(envConfig.accountsConfigPath);

  // 2. Register health checkers per provider
  const healthCheckerRegistry = new HealthCheckerRegistry();
  healthCheckerRegistry.register('wwebjs-api', new WwebjsHealthChecker());
  healthCheckerRegistry.register('telegram-bot-api', new TelegramBotHealthChecker());
  healthCheckerRegistry.register('brevo', new BrevoHealthChecker());
  healthCheckerRegistry.register('twilio', new TwilioHealthChecker());
  healthCheckerRegistry.register('messagebird', new MessageBirdHealthChecker());

  // 3. Validate credentials against real provider APIs
  const credentialValidator = new CredentialValidator(healthCheckerRegistry);
  console.log(`Loaded ${rawAccounts.length} account(s) from configuration, validating credentials...`);
  const accounts = await credentialValidator.validateAll(rawAccounts);

  const active = accounts.filter((a) => a.status === 'active').length;
  const authExpired = accounts.filter((a) => a.status === 'auth_expired').length;
  const unchecked = accounts.filter((a) => a.status === 'unchecked').length;
  const errored = accounts.filter((a) => a.status === 'error').length;
  console.log(`Validation complete: ${active} active, ${authExpired} auth_expired, ${unchecked} unchecked, ${errored} error`);

  // 4. Create repository (with persistence back to YAML)
  const accountsYamlPath = envConfig.accountsConfigPath ?? resolve(process.cwd(), 'config/accounts.yaml');
  const accountRepository = new InMemoryAccountRepository(accounts, accountsYamlPath);

  // 5. Create adapter factory and register adapters
  const adapterFactory = new AdapterFactory();
  adapterFactory.register('wwebjs-api', WwebjsApiAdapter);

  // 6. Create services
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

  // 7. Create health check scheduler
  const healthCheckIntervalMs = parseInt(process.env['HEALTH_CHECK_INTERVAL_MS'] ?? '300000', 10);
  const healthCheckScheduler = new HealthCheckScheduler(
    accountRepository,
    credentialValidator,
    { intervalMs: healthCheckIntervalMs },
  );

  // 8. Create and start server
  const server = await createServer({
    accountRepository,
    webhookConfigRepo,
    messageRouter,
    adapterFactory,
    credentialValidator,
    healthCheckScheduler,
    webhookForwarder,
    port: envConfig.port,
    logLevel: envConfig.logLevel,
  });

  try {
    await server.listen({ port: envConfig.port, host: '0.0.0.0' });
    console.log(`Unified Messaging Gateway listening on port ${envConfig.port}`);
    console.log(`Swagger UI available at http://localhost:${envConfig.port}/docs`);

    // Start periodic health checks after server is ready
    healthCheckScheduler.start();
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

main();
