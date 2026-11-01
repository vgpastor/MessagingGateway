import { resolve } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { InMemoryAccountRepository } from '../../src/infrastructure/config/in-memory-account.repository.js';
import { loadAccountsFromYaml } from '../../src/infrastructure/config/accounts.loader.js';
import type { AccountStatus } from '../../src/core/accounts/channel-account.js';
import type { ConnectionManagerPort } from '../../src/core/accounts/connection-manager.port.js';
import { ProviderRegistry } from '../../src/integrations/provider-registry.js';
import { wwebjsProvider } from '../../src/integrations/whatsapp/wwebjs-api/index.js';
import { ADMIN_KEY, buildTestServer } from './helpers/test-server.js';

let app: FastifyInstance | undefined;

async function serverWith(statuses: Record<string, AccountStatus>): Promise<FastifyInstance> {
  const accounts = loadAccountsFromYaml(resolve(process.cwd(), 'tests/fixtures/accounts.yaml'))
    .map((a) => ({ ...a, status: statuses[a.id] ?? ('active' as AccountStatus) }));
  app = await buildTestServer({ accountRepository: new InMemoryAccountRepository(accounts) });
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /health', () => {
  it('returns ok when all accounts are active', async () => {
    const server = await serverWith({});
    const res = await server.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.version).toBeTypeOf('string');
  });

  it('is public, so it says nothing about individual accounts', async () => {
    const server = await serverWith({ 'wa-acme': 'auth_expired' });
    const res = await server.inject({ method: 'GET', url: '/health' });

    expect(res.json().accounts).toBeUndefined();
    expect(res.body).not.toContain('wa-acme');
  });

  it('leaves the detail per account to the authenticated API', async () => {
    const server = await serverWith({ 'wa-acme': 'auth_expired' });

    expect((await server.inject({ method: 'GET', url: '/api/v1/accounts/wa-acme' })).statusCode).toBe(401);
    const res = await server.inject({ method: 'GET', url: '/api/v1/accounts/wa-acme', headers: { 'x-api-key': ADMIN_KEY } });
    expect(res.json().status).toBe('auth_expired');
  });

  it('is degraded when an active account has lost its connection: its status does not change during a cut', async () => {
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(wwebjsProvider);
    const live = { status: 'connected' };
    providerRegistry.register({
      ...wwebjsProvider,
      connection: () => ({ getConnectionInfo: () => ({ status: live.status }) }) as unknown as ConnectionManagerPort,
    });
    const accounts = loadAccountsFromYaml(resolve(process.cwd(), 'tests/fixtures/accounts.yaml')).map((a) => ({ ...a, status: 'active' as AccountStatus }));
    app = await buildTestServer({ accountRepository: new InMemoryAccountRepository(accounts), providerRegistry });

    expect((await app.inject({ method: 'GET', url: '/health' })).json().status).toBe('ok');

    live.status = 'disconnected';
    expect((await app.inject({ method: 'GET', url: '/health' })).json().status).toBe('degraded');
  });

  it('/health returns degraded when an account is auth_expired (still HTTP 200)', async () => {
    const server = await serverWith({ 'wa-acme': 'auth_expired' });
    const res = await server.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('degraded');
  });

  it.each(['error', 'unchecked'] as const)('is degraded when an account is %s', async (status) => {
    const server = await serverWith({ 'wa-test': status });
    const res = await server.inject({ method: 'GET', url: '/health' });

    expect(res.json().status).toBe('degraded');
  });

  it('a suspended (operator-disabled) account does not mark the gateway degraded', async () => {
    const server = await serverWith({ 'wa-demo': 'suspended' });
    const res = await server.inject({ method: 'GET', url: '/health' });

    expect(res.json().status).toBe('ok');
  });
});
