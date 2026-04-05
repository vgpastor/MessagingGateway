import { createHmac, timingSafeEqual } from 'node:crypto';

/** Framework-agnostic request type for auth guard */
export interface AuthRequest {
  headers: Record<string, string | string[] | undefined>;
}

/** Framework-agnostic reply type for auth guard */
export interface AuthReply {
  status(code: number): AuthReply;
  send(data: unknown): unknown;
}

/**
 * API Key authentication guard.
 *
 * Accepts the key via:
 *   - Header: `Authorization: Bearer <key>`
 *   - Header: `X-API-Key: <key>`
 *
 * If no API key is configured (apiKey is undefined), all requests pass through (dev mode).
 */
export function createApiKeyGuard(apiKey: string) {
  return async function apiKeyGuard(request: AuthRequest, reply: AuthReply): Promise<void> {
    const provided = extractApiKey(request);
    if (!provided) {
      reply.status(401).send({
        error: 'Unauthorized',
        message: 'Missing API key. Provide via Authorization: Bearer <key> or X-API-Key header.',
      });
      return;
    }

    if (!safeCompare(provided, apiKey)) {
      reply.status(401).send({
        error: 'Unauthorized',
        message: 'Invalid API key.',
      });
      return;
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

function extractApiKey(request: AuthRequest): string | undefined {
  const authHeader = request.headers['authorization'];
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
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
