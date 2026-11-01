/**
 * The read-only API key may only read messages and media (the event stream authenticates itself);
 * everything else, including /metrics and the account/QR endpoints, needs the admin key.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SqliteMessageStore } from '../../src/persistence/sqlite-message-store.js';
import { buildTestServer, createLogCapture, ADMIN_KEY, READ_KEY } from './helpers/test-server.js';

const READ = { 'x-api-key': READ_KEY };
const ADMIN = { 'x-api-key': ADMIN_KEY };

let app: FastifyInstance;
let store: SqliteMessageStore;

beforeAll(async () => {
  store = new SqliteMessageStore(':memory:');
  await store.init();
  await store.runMigrations();
  app = await buildTestServer({ messageStore: store });
});

afterAll(async () => {
  await app.close();
  await store.close();
});

describe('read-only API key', () => {
  it('can GET /api/v1/messages', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/messages', headers: READ });
    expect(res.statusCode).toBe(200);
  });

  it('can GET /api/v1/messages/stats', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/messages/stats', headers: READ });
    expect(res.statusCode).toBe(200);
  });

  // A real server, so a route renamed in its controller cannot leave the allow-list behind.
  it.each([
    '/api/v1/messages',
    '/api/v1/messages/ABC123',
    '/api/v1/messages/stats',
    '/api/v1/messages/search?q=x',
    '/api/v1/messages/analytics',
    '/api/v1/messages/export',
    '/api/v1/media/ABC123',
  ])('is allowed on GET %s', async (url) => {
    const res = await app.inject({ method: 'GET', url, headers: READ });
    expect(res.statusCode).not.toBe(403);
    expect(res.statusCode).not.toBe(401);
  });

  it('cannot ask the provider for a delivery status', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/messages/ABC123/status?accountId=wa-test', headers: READ });
    expect(res.statusCode).toBe(403);
  });

  it('cannot read the conversation context', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/conversations/c1/context', headers: READ });
    expect(res.statusCode).toBe(403);
  });

  it('cannot POST /api/v1/accounts/:id/reset', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/accounts/wa-test/reset', headers: READ });
    expect(res.statusCode).toBe(403);
  });

  it('cannot read accounts (they carry the QR)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/accounts/wa-test', headers: READ });
    expect(res.statusCode).toBe(403);
  });

  it('cannot send messages', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/messages/send',
      headers: { ...READ, 'content-type': 'application/json' },
      payload: { to: '+34600000000', content: { type: 'text', body: 'x' } },
    });
    expect(res.statusCode).toBe(403);
  });

  it('cannot GET /metrics', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics', headers: READ });
    expect(res.statusCode).toBe(403);
  });
});

describe('authentication runs before the body is read', () => {
  const malformed = { 'content-type': 'application/json' };

  it('answers 401 to a request without key whatever its body', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/messages/send', headers: malformed, payload: '{not json' });
    expect(res.statusCode).toBe(401);
  });

  it('answers 401 to an oversized body without key, not 413', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/messages/send', headers: malformed, payload: 'x'.repeat(2 * 1024 * 1024) });
    expect(res.statusCode).toBe(401);
  });

  it('answers 403 to the read key whatever its body', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/messages/send', headers: { ...READ, ...malformed }, payload: '{not json' });
    expect(res.statusCode).toBe(403);
  });

  it('still reads the body for a valid key', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/messages/send', headers: { ...ADMIN, ...malformed }, payload: '{not json' });
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).not.toBe(403);
  });
});

describe('/metrics', () => {
  it('is no longer public', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(401);
  });

  it('is served to the admin key', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics', headers: ADMIN });
    expect(res.statusCode).toBe(200);
  });
});

describe('admin API key', () => {
  it('keeps full access', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/accounts', headers: ADMIN });
    expect(res.statusCode).toBe(200);
  });

  it('/health stays public', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });
});

describe('request logs', () => {
  it('request log redacts token query', async () => {
    const secret = 'S3CRET-TOKEN-VALUE';
    const logs = createLogCapture();
    const server = await buildTestServer({ logLevel: 'info', logStream: logs.stream });
    await server.inject({ method: 'GET', url: `/api/v1/accounts?token=${secret}&accounts=wa`, headers: ADMIN });
    await server.close();

    expect(logs.text()).not.toContain(secret);
    expect(logs.text()).toContain('token=***');
    expect(logs.text()).toContain('/api/v1/accounts');
  });

  it('logs method, status and response time, and skips /health', async () => {
    const logs = createLogCapture();
    const server = await buildTestServer({ logLevel: 'info', logStream: logs.stream });
    await server.inject({ method: 'GET', url: '/health' });
    await server.inject({ method: 'GET', url: '/api/v1/accounts', headers: ADMIN });
    await server.close();

    const requestLogs = logs.lines().filter((l) => l['statusCode'] !== undefined);
    expect(requestLogs).toHaveLength(1);
    expect(requestLogs[0]).toMatchObject({ method: 'GET', url: '/api/v1/accounts', statusCode: 200 });
    expect(typeof requestLogs[0]!['responseTime']).toBe('number');
    expect(logs.text()).not.toContain('/health');
  });

  it('never logs the token of a failed request', async () => {
    const secret = 'ERR-TOKEN-VALUE';
    const logs = createLogCapture();
    const server = await buildTestServer({ logLevel: 'info', logStream: logs.stream });
    // Malformed JSON makes Fastify log the failed request with its `req` object.
    await server.inject({
      method: 'POST',
      url: `/api/v1/messages/send?token=${secret}`,
      headers: { ...ADMIN, 'content-type': 'application/json' },
      payload: '{not json',
    });
    await server.close();

    expect(logs.text()).not.toContain(secret);
  });
});
