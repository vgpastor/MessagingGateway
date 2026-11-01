/**
 * Builds the real Fastify server with in-memory collaborators, for integration tests
 * of auth scopes, logging and the WebSocket endpoint.
 */
import { resolve } from 'node:path';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { loadAccountsFromYaml } from '../../../src/infrastructure/config/accounts.loader.js';
import { InMemoryAccountRepository } from '../../../src/infrastructure/config/in-memory-account.repository.js';
import { ProviderRegistry } from '../../../src/integrations/provider-registry.js';
import { wwebjsProvider } from '../../../src/integrations/whatsapp/wwebjs-api/index.js';
import { MessageRouterService } from '../../../src/core/routing/message-router.service.js';
import { WebhookForwarder } from '../../../src/connections/webhooks/webhook-forwarder.js';
import { CredentialValidator } from '../../../src/infrastructure/credential-validator.js';
import { createServer, type ServerDeps } from '../../../src/infrastructure/server.js';
import type { WebhookConfigRepository } from '../../../src/core/webhooks/webhook-config.repository.js';

export const ADMIN_KEY = 'admin-test-key';
export const READ_KEY = 'read-test-key';

export async function buildTestServer(overrides: Partial<ServerDeps> = {}): Promise<FastifyInstance> {
  const accounts = loadAccountsFromYaml(resolve(process.cwd(), 'tests/fixtures/accounts.yaml'));
  const accountRepository = new InMemoryAccountRepository(accounts);
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(wwebjsProvider);
  const webhookConfigRepo = { findAll: async () => [], findByAccountId: async () => [] } as unknown as WebhookConfigRepository;

  const app = await createServer({
    accountRepository,
    webhookConfigRepo,
    providerRegistry,
    messageRouter: new MessageRouterService(accountRepository, providerRegistry),
    credentialValidator: new CredentialValidator(providerRegistry),
    webhookForwarder: new WebhookForwarder(webhookConfigRepo, undefined, undefined),
    apiKey: ADMIN_KEY,
    readApiKey: READ_KEY,
    port: 0,
    logLevel: 'silent',
    ...overrides,
  });
  await app.ready();
  return app;
}

/** A log sink that keeps everything the server writes, to assert on the emitted log lines. */
export function createLogCapture() {
  let output = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      output += chunk.toString();
      cb();
    },
  });
  return {
    stream,
    text: () => output,
    lines: () => output.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}
