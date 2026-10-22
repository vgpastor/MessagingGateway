import { createHmac, timingSafeEqual } from 'node:crypto';
import { getLogger } from '../logger/logger.port.js';

/** What a credential is allowed to do: `admin` everything, `read` only the read-only routes. */
export type AuthScope = 'admin' | 'read';

/** Framework-agnostic request type for auth guard */
export interface AuthRequest {
  headers: Record<string, string | string[] | undefined>;
  method?: string;
  /** Raw URL, query string included. */
  url?: string;
  /** Matched route (Fastify): `url` is the route pattern, e.g. `/api/v1/messages/:id`. */
  routeOptions?: { url?: string };
  /** Set by the guard once the key is accepted. */
  authScope?: AuthScope;
}

/** Framework-agnostic reply type for auth guard */
export interface AuthReply {
  status(code: number): AuthReply;
  send(data: unknown): unknown;
}

export interface ApiKeys {
  adminKey: string;
  /** Optional key that can only read messages and media and open the event stream. */
  readKey?: string;
}

/**
 * Resolves which scope a key grants, or `undefined` when it matches none.
 * A read key equal to the admin key grants admin.
 */
export function resolveAuthScope(provided: string | undefined, keys: ApiKeys): AuthScope | undefined {
  if (!provided) return undefined;
  if (safeCompare(provided, keys.adminKey)) return 'admin';
  if (keys.readKey && safeCompare(provided, keys.readKey)) return 'read';
  return undefined;
}

/**
 * Routes the read scope may call. Anything else answers 403.
 * Judged on the matched route pattern when the router provides it, so a crafted URL cannot
 * make a different route look like a read route.
 */
export function isReadScopeAllowed(request: Pick<AuthRequest, 'method' | 'url' | 'routeOptions'>): boolean {
  if (request.method?.toUpperCase() !== 'GET') return false;
  const path = request.routeOptions?.url ?? (request.url ?? '').split('?')[0] ?? '';
  return (
    path === '/api/v1/messages' ||
    path.startsWith('/api/v1/messages/') ||
    path.startsWith('/api/v1/media/') ||
    path === '/ws/events'
  );
}

/**
 * API Key authentication guard.
 *
 * Accepts the key via:
 *   - Header: `Authorization: Bearer <key>`
 *   - Header: `X-API-Key: <key>`
 *
 * The admin key can do everything. The optional read key can only call the routes accepted by
 * {@link isReadScopeAllowed}; on any other route it gets 403. The accepted scope is stored in
 * `request.authScope`.
 */
export function createApiKeyGuard(keys: ApiKeys) {
  if (keys.readKey && safeCompare(keys.readKey, keys.adminKey)) {
    getLogger().warn('READ_API_KEY equals API_KEY: the "read" key is treated as admin. Use a distinct read key.');
  }

  return async function apiKeyGuard(request: AuthRequest, reply: AuthReply): Promise<void> {
    const provided = extractApiKey(request);
    if (!provided) {
      reply.status(401).send({
        error: 'Unauthorized',
        message: 'Missing API key. Provide via Authorization: Bearer <key> or X-API-Key header.',
      });
      return;
    }

    const scope = resolveAuthScope(provided, keys);
    if (!scope) {
      reply.status(401).send({
        error: 'Unauthorized',
        message: 'Invalid API key.',
      });
      return;
    }

    if (scope === 'read' && !isReadScopeAllowed(request)) {
      reply.status(403).send({
        error: 'Forbidden',
        message: 'This API key is read-only: it can only read messages and media.',
      });
      return;
    }

    request.authScope = scope;
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

/** Reads the key from `Authorization: Bearer` or `X-API-Key`. */
export function extractApiKey(request: Pick<AuthRequest, 'headers'>): string | undefined {
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
