/**
 * Fastify's own error logs must survive the redacted access-log setup: only the per-request
 * "incoming" / "completed" lines are replaced.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { requestSerializers } from '../../src/infrastructure/logging/request-serializers.js';
import { QuietRequestLogController } from '../../src/infrastructure/logging/quiet-request-log-controller.js';
import { createLogCapture } from './helpers/test-server.js';

const PINO_WARN = 40;
const PINO_ERROR = 50;

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function build() {
  const logs = createLogCapture();
  app = Fastify({
    logger: { level: 'info', stream: logs.stream, serializers: requestSerializers },
    logController: new QuietRequestLogController(),
  });
  app.get('/boom', async () => {
    throw new Error('handler exploded');
  });
  app.post('/validated', {
    schema: { body: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } },
  }, async () => ({ ok: true }));
  app.get('/bad-response', {
    schema: {
      response: { 200: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
    },
  }, async () => ({ nope: 1 }));
  return logs;
}

describe('Fastify error logs with the quiet request log controller', () => {
  it('logs a thrown handler error at error level with its stack', async () => {
    const logs = build();
    const res = await app!.inject({ method: 'GET', url: '/boom' });

    expect(res.statusCode).toBe(500);
    const entry = logs.lines().find((l) => l['level'] === PINO_ERROR && l['msg'] === 'handler exploded');
    expect(entry).toBeDefined();
    expect(String((entry!['err'] as Record<string, unknown>)['stack'])).toContain('handler exploded');
  });

  it('does NOT log a 400 validation error at error level', async () => {
    const logs = build();
    const res = await app!.inject({ method: 'POST', url: '/validated', payload: { other: 1 } });

    expect(res.statusCode).toBe(400);
    expect(logs.lines().filter((l) => (l['level'] as number) >= PINO_ERROR)).toHaveLength(0);
  });

  it('logs a response serialization failure with details', async () => {
    const logs = build();
    const res = await app!.inject({ method: 'GET', url: '/bad-response' });

    expect(res.statusCode).toBe(500);
    const entry = logs.lines().find((l) => (l['level'] as number) >= PINO_ERROR);
    expect(entry).toBeDefined();
    expect(String(entry!['msg'])).toContain('"id" is required'); // names the missing property
  });

  it('does not print Fastify\'s incoming/completed request lines', async () => {
    const logs = build();
    await app!.inject({ method: 'GET', url: '/boom?token=SECRET' });

    const msgs = logs.lines().map((l) => l['msg']);
    expect(msgs).not.toContain('incoming request');
    expect(msgs).not.toContain('request completed');
    expect(msgs).not.toContain('request errored');
  });

  it('logs unknown routes with the URL redacted', async () => {
    const logs = build();
    await app!.inject({ method: 'GET', url: '/nope?%74oken=SECRET' });

    expect(logs.text()).not.toContain('SECRET');
    expect(logs.lines().some((l) => String(l['msg']).includes('not found'))).toBe(true);
  });
});

describe('error logs never carry the raw token (warn level and above)', () => {
  it('redacts the token in the req of a 5xx log', async () => {
    const logs = build();
    await app!.inject({ method: 'GET', url: '/boom?%74oken=SECRET' });

    expect(logs.text()).not.toContain('SECRET');
    expect(logs.lines().some((l) => (l['level'] as number) >= PINO_WARN)).toBe(true);
  });
});
