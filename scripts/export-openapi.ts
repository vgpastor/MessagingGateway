/**
 * Exports the OpenAPI schema from the gateway to openapi.json.
 * Run with: npx tsx scripts/export-openapi.ts
 */
import { resolve } from 'node:path';
import { writeFileSync, unlinkSync } from 'node:fs';

async function main() {
  process.env['NODE_ENV'] = 'development';
  process.env['SWAGGER_ENABLED'] = 'true';
  process.env['API_KEY'] = 'schema-export';

  const { InMemoryAccountRepository } = await import('../src/infrastructure/config/in-memory-account.repository.js');
  const { ProviderRegistry } = await import('../src/integrations/provider-registry.js');
  const { MessageRouterService } = await import('../src/core/routing/message-router.service.js');
  const { FileWebhookConfigStore } = await import('../src/connections/webhooks/file-webhook-config.store.js');
  const { WebhookForwarder } = await import('../src/connections/webhooks/webhook-forwarder.js');
  const { CredentialValidator } = await import('../src/infrastructure/credential-validator.js');
  const { createServer } = await import('../src/infrastructure/server.js');

  const accountRepository = new InMemoryAccountRepository([]);
  const providerRegistry = new ProviderRegistry();
  const credentialValidator = new CredentialValidator(providerRegistry);
  const messageRouter = new MessageRouterService(accountRepository, providerRegistry);
  const tmpPath = resolve(process.cwd(), '.tmp-webhooks.json');
  const webhookConfigRepo = await FileWebhookConfigStore.create(tmpPath);
  const webhookForwarder = new WebhookForwarder(webhookConfigRepo, undefined, undefined);

  const server = await createServer({
    accountRepository, webhookConfigRepo, providerRegistry,
    messageRouter, credentialValidator, webhookForwarder,
    apiKey: 'schema-export', port: 0, logLevel: 'silent',
  });

  await server.ready();
  const spec = server.swagger();
  const output = resolve(process.cwd(), 'openapi.json');
  writeFileSync(output, JSON.stringify(spec, null, 2));
  console.log(`OpenAPI schema exported to ${output} (${Object.keys(spec.paths ?? {}).length} paths)`);
  await server.close();

  try { unlinkSync(tmpPath); } catch {}
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed to export OpenAPI schema:', err);
  process.exit(1);
});
