import { describe, it, expect, vi } from 'vitest';
import { createApiKeyGuard, resolveAuthScope, validateWebhookSignature } from '../../../src/core/auth/api-key.guard.js';
import { createHmac } from 'node:crypto';

function mockRequest(headers: Record<string, string> = {}) {
  return { headers } as any;
}

function mockReply() {
  const reply = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { reply.statusCode = code; return reply; },
    send(body: unknown) { reply.body = body; return reply; },
  };
  return reply as any;
}

describe('createApiKeyGuard', () => {
  it('should reject request with no key', async () => {
    const guard = createApiKeyGuard({ adminKey: 'my-secret-key' });
    const reply = mockReply();

    await guard(mockRequest(), reply);

    expect(reply.statusCode).toBe(401);
  });

  it('should accept valid Bearer token', async () => {
    const guard = createApiKeyGuard({ adminKey: 'my-secret-key' });
    const reply = mockReply();

    await guard(mockRequest({ authorization: 'Bearer my-secret-key' }), reply);

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toBeUndefined();
  });

  it('should accept valid X-API-Key header', async () => {
    const guard = createApiKeyGuard({ adminKey: 'my-secret-key' });
    const reply = mockReply();

    await guard(mockRequest({ 'x-api-key': 'my-secret-key' }), reply);

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toBeUndefined();
  });

  it('should reject missing key when configured', async () => {
    const guard = createApiKeyGuard({ adminKey: 'my-secret-key' });
    const reply = mockReply();

    await guard(mockRequest(), reply);

    expect(reply.statusCode).toBe(401);
    expect((reply.body as Record<string, string>).error).toBe('Unauthorized');
    expect((reply.body as Record<string, string>).code).toBe('MISSING_API_KEY');
  });

  it('gives an invalid key its own code', async () => {
    const guard = createApiKeyGuard({ adminKey: 'correct-key' });
    const reply = mockReply();

    await guard(mockRequest({ 'x-api-key': 'wrong-key' }), reply);

    expect((reply.body as Record<string, string>).code).toBe('INVALID_API_KEY');
  });

  it('should reject invalid key', async () => {
    const guard = createApiKeyGuard({ adminKey: 'correct-key' });
    const reply = mockReply();

    await guard(mockRequest({ 'x-api-key': 'wrong-key' }), reply);

    expect(reply.statusCode).toBe(401);
    expect((reply.body as Record<string, string>).message).toBe('Invalid API key.');
  });

  it('should reject Bearer with wrong key', async () => {
    const guard = createApiKeyGuard({ adminKey: 'correct-key' });
    const reply = mockReply();

    await guard(mockRequest({ authorization: 'Bearer wrong-key' }), reply);

    expect(reply.statusCode).toBe(401);
  });

  it('should reject non-Bearer authorization', async () => {
    const guard = createApiKeyGuard({ adminKey: 'my-key' });
    const reply = mockReply();

    await guard(mockRequest({ authorization: 'Basic dXNlcjpwYXNz' }), reply);

    expect(reply.statusCode).toBe(401);
  });
});

describe('validateWebhookSignature', () => {
  const secret = 'webhook-secret';
  const body = '{"test":"payload"}';

  it('should accept when no secret configured', () => {
    expect(validateWebhookSignature(body, undefined, undefined)).toBe(true);
  });

  it('should accept valid signature', () => {
    const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    expect(validateWebhookSignature(body, sig, secret)).toBe(true);
  });

  it('should reject missing signature when secret configured', () => {
    expect(validateWebhookSignature(body, undefined, secret)).toBe(false);
  });

  it('should reject invalid signature', () => {
    expect(validateWebhookSignature(body, 'sha256=invalid', secret)).toBe(false);
  });

  it('should reject wrong body with valid format', () => {
    const sig = `sha256=${createHmac('sha256', secret).update('different-body').digest('hex')}`;
    expect(validateWebhookSignature(body, sig, secret)).toBe(false);
  });
});

function scopedRequest(headers: Record<string, string>, method: string, routePattern?: string) {
  return {
    headers,
    method,
    ...(routePattern ? { routeOptions: { url: routePattern } } : {}),
  } as any;
}

describe('createApiKeyGuard with a read-only key', () => {
  const guard = createApiKeyGuard({ adminKey: 'admin-key', readKey: 'read-key' });
  const READ = { 'x-api-key': 'read-key' };
  const ADMIN = { 'x-api-key': 'admin-key' };

  it('marks the admin key as scope admin and lets it through everywhere', async () => {
    const req = scopedRequest(ADMIN, 'POST', '/api/v1/accounts/:id/reset');
    const reply = mockReply();

    await guard(req, reply);

    expect(reply.body).toBeUndefined();
    expect(req.authScope).toBe('admin');
  });

  it.each([
    '/api/v1/messages',
    '/api/v1/messages/:id',
    '/api/v1/messages/stats',
    '/api/v1/messages/search',
    '/api/v1/messages/analytics',
    '/api/v1/messages/export',
    '/api/v1/media/:id',
  ])('read key may GET %s', async (route) => {
    const req = scopedRequest(READ, 'GET', route);
    const reply = mockReply();

    await guard(req, reply);

    expect(reply.body).toBeUndefined();
    expect(reply.statusCode).toBe(200);
    expect(req.authScope).toBe('read');
  });

  it.each([
    ['POST', '/api/v1/accounts/:id/reset'],
    ['GET', '/api/v1/accounts'],
    ['GET', '/api/v1/accounts/:id/qr'],
    ['GET', '/metrics'],
    ['POST', '/api/v1/messages'],
    ['DELETE', '/api/v1/messages/:id'],
    ['POST', '/api/v1/messages/send'],
    ['GET', '/api/v1/messages/:id/status'],
    ['GET', '/api/v1/messagesfoo'],
    ['GET', '/api/v1/media'],
    ['GET', '/ws/events'],
    ['GET', undefined],
  ])('read key gets 403 on %s %s', async (method, route) => {
    const req = scopedRequest(READ, method, route);
    const reply = mockReply();

    await guard(req, reply);

    expect(reply.statusCode).toBe(403);
    expect((reply.body as Record<string, string>).error).toBe('Forbidden');
    expect((reply.body as Record<string, string>).code).toBe('READ_ONLY_API_KEY');
  });

  it('rejects an unknown key with 401, not 403', async () => {
    const reply = mockReply();

    await guard(scopedRequest({ 'x-api-key': 'other' }, 'GET', '/api/v1/messages'), reply);

    expect(reply.statusCode).toBe(401);
  });

  it('without a read key configured, behaves as admin-only', async () => {
    const adminOnly = createApiKeyGuard({ adminKey: 'admin-key' });
    const reply = mockReply();

    await adminOnly(scopedRequest(READ, 'GET', '/api/v1/messages'), reply);

    expect(reply.statusCode).toBe(401);
  });

  it('a read key equal to the admin key is treated as admin', async () => {
    const same = createApiKeyGuard({ adminKey: 'same-key', readKey: 'same-key' });
    const req = scopedRequest({ 'x-api-key': 'same-key' }, 'POST', '/api/v1/accounts/:id/reset');
    const reply = mockReply();

    await same(req, reply);

    expect(reply.body).toBeUndefined();
    expect(req.authScope).toBe('admin');
  });
});

describe('resolveAuthScope', () => {
  it('maps a key to its scope', () => {
    const keys = { adminKey: 'a', readKey: 'r' };
    expect(resolveAuthScope('a', keys)).toBe('admin');
    expect(resolveAuthScope('r', keys)).toBe('read');
    expect(resolveAuthScope('x', keys)).toBeUndefined();
    expect(resolveAuthScope(undefined, keys)).toBeUndefined();
    expect(resolveAuthScope('r', { adminKey: 'a' })).toBeUndefined();
  });
});
