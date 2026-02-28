import { loadEnvConfig } from './infrastructure/config/env.config.js';
import { loadAccountsFromYaml, validateAccountCredentials } from './infrastructure/config/accounts.loader.js';
import { InMemoryAccountRepository } from './infrastructure/config/in-memory-account.repository.js';
import { AdapterFactory } from './adapters/adapter.factory.js';
import { WwebjsApiAdapter } from './adapters/whatsapp/wwebjs-api/wwebjs.adapter.js';
import { MessageRouterService } from './domain/routing/message-router.service.js';
import { WebhookForwarder } from './infrastructure/webhook-forwarder.js';
import { createServer } from './infrastructure/server.js';

async function main() {
  // 1. Load configuration
  const envConfig = loadEnvConfig();
  const rawAccounts = loadAccountsFromYaml(envConfig.accountsConfigPath);
  const accounts = validateAccountCredentials(rawAccounts);

  const active = accounts.filter((a) => a.status === 'active').length;
  const unchecked = accounts.filter((a) => a.status === 'unchecked').length;
  console.log(`Loaded ${accounts.length} account(s): ${active} active, ${unchecked} unchecked (missing credentials)`);

  // 2. Create repository
  const accountRepository = new InMemoryAccountRepository(accounts);

  // 3. Create adapter factory and register adapters
  const adapterFactory = new AdapterFactory();
  adapterFactory.register('wwebjs-api', WwebjsApiAdapter);

  // 4. Create services
  const messageRouter = new MessageRouterService(accountRepository, adapterFactory);
  const webhookForwarder = new WebhookForwarder(
    envConfig.webhookCallbackUrl,
    envConfig.webhookCallbackSecret,
  );

  // 5. Create and start server
  const server = await createServer({
    accountRepository,
    messageRouter,
    adapterFactory,
    webhookForwarder,
    port: envConfig.port,
    logLevel: envConfig.logLevel,
  });

  try {
    await server.listen({ port: envConfig.port, host: '0.0.0.0' });
    console.log(`Unified Messaging Gateway listening on port ${envConfig.port}`);
    console.log(`Swagger UI available at http://localhost:${envConfig.port}/docs`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

main();
