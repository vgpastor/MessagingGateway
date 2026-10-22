import { resolve } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { InMemoryAccountRepository } from '../../src/infrastructure/config/in-memory-account.repository.js';
import { loadAccountsFromYaml } from '../../src/infrastructure/config/accounts.loader.js';
import type { AccountStatus } from '../../src/core/accounts/channel-account.js';
import { buildTestServer } from './helpers/test-server.js';

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
  it('returns ok with every account status when all accounts are active', async () => {
    const server = await serverWith({});
    const res = await server.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.accounts['wa-acme']).toBe('active');
    expect(Object.values(body.accounts).every((s) => s === 'active')).toBe(true);
    expect(body.version).toBeTypeOf('string');
  });

  it('/health returns degraded when an account is auth_expired (still HTTP 200)', async () => {
    const server = await serverWith({ 'wa-acme': 'auth_expired' });
    const res = await server.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('degraded');
    expect(body.accounts['wa-acme']).toBe('auth_expired');
  });

  it.each(['error', 'unchecked'] as const)('is degraded when an account is %s', async (status) => {
    const server = await serverWith({ 'wa-test': status });
    const res = await server.inject({ method: 'GET', url: '/health' });

    expect(res.json().status).toBe('degraded');
  });

  it('lists a suspended (operator-disabled) account without marking the gateway degraded', async () => {
    const server = await serverWith({ 'wa-demo': 'suspended' });
    const res = await server.inject({ method: 'GET', url: '/health' });

    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.accounts['wa-demo']).toBe('suspended');
  });
});
