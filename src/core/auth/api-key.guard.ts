import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';

/**
 * API Key authentication guard for Fastify routes.
 *
 * Accepts the key via:
 *   - Header: `Authorization: Bearer <key>`
 *   - Header: `X-API-Key: <key>`
 *
 * If no API key is configured (apiKey is undefined), all requests pass through (dev mode).
 */
export function createApiKeyGuard(apiKey: string) {
  return async function apiKeyGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const provided = extractApiKey(request);
    if (!provided) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Missing API key. Provide via Authorization: Bearer <key> or X-API-Key header.',
      });
    }

    if (!safeCompare(provided, apiKey)) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Invalid API key.',
      });
    }
  };
}

/**
 * Validate an inbound webhook signature against a secret.
 * Returns true if valid or if no secret is configured.
 */
export function validateWebhookSignature(
  body: string,
  signatureHeader: string | undefined,
  secret: string | undefined,
): boolean {
  if (!secret) return true; // No secret configured, accept (dev mode)
  if (!signatureHeader) return false;

  const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  return safeCompare(signatureHeader, expected);
}

function extractApiKey(request: FastifyRequest): string | undefined {
  const authHeader = request.headers['authorization'];
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  const apiKeyHeader = request.headers['x-api-key'];
  if (typeof apiKeyHeader === 'string') {
    return apiKeyHeader;
  }

  return undefined;
}

export function safeCompare(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(a, 'utf-8');
    const bufB = Buffer.from(b, 'utf-8');
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}
