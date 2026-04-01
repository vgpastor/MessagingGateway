import { describe, it, expect, vi } from 'vitest';
import { createApiKeyGuard, validateWebhookSignature } from '../../../src/core/auth/api-key.guard.js';
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
  it('should pass through when no API key configured (dev mode)', async () => {
    const guard = createApiKeyGuard(undefined);
    const reply = mockReply();

    await guard(mockRequest(), reply);

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toBeUndefined();
  });

  it('should accept valid Bearer token', async () => {
    const guard = createApiKeyGuard('my-secret-key');
    const reply = mockReply();

    await guard(mockRequest({ authorization: 'Bearer my-secret-key' }), reply);

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toBeUndefined();
  });

  it('should accept valid X-API-Key header', async () => {
    const guard = createApiKeyGuard('my-secret-key');
    const reply = mockReply();

    await guard(mockRequest({ 'x-api-key': 'my-secret-key' }), reply);

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toBeUndefined();
  });

  it('should reject missing key when configured', async () => {
    const guard = createApiKeyGuard('my-secret-key');
    const reply = mockReply();

    await guard(mockRequest(), reply);

    expect(reply.statusCode).toBe(401);
    expect((reply.body as Record<string, string>).error).toBe('Unauthorized');
  });

  it('should reject invalid key', async () => {
    const guard = createApiKeyGuard('correct-key');
    const reply = mockReply();

    await guard(mockRequest({ 'x-api-key': 'wrong-key' }), reply);

    expect(reply.statusCode).toBe(401);
    expect((reply.body as Record<string, string>).message).toBe('Invalid API key.');
  });

  it('should reject Bearer with wrong key', async () => {
    const guard = createApiKeyGuard('correct-key');
    const reply = mockReply();

    await guard(mockRequest({ authorization: 'Bearer wrong-key' }), reply);

    expect(reply.statusCode).toBe(401);
  });

  it('should reject non-Bearer authorization', async () => {
    const guard = createApiKeyGuard('my-key');
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
