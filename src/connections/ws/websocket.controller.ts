import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocketBroadcaster } from './websocket-broadcaster.js';
import { extractApiKey, resolveAuthScope } from '../../core/auth/api-key.guard.js';

interface WebSocketControllerDeps {
  wsBroadcaster: WebSocketBroadcaster;
  apiKey: string;
  /** Optional read-only key: can listen to events but not send, and never receives QR codes. */
  readApiKey?: string;
}

/** Prefix of the `Sec-WebSocket-Protocol` entry that carries the API key (`umg.<key>`). */
const KEY_SUBPROTOCOL_PREFIX = 'umg.';

/**
 * `handleProtocols` for the WebSocket server: selects the `umg.<key>` entry so it is echoed in the
 * handshake response (browsers drop a connection whose requested subprotocol is not selected).
 * Authentication itself happens in the route handler.
 */
export function selectKeyProtocol(protocols: Set<string>): string | false {
  for (const protocol of protocols) {
    if (protocol.startsWith(KEY_SUBPROTOCOL_PREFIX)) return protocol;
  }
  return false;
}

function extractSubprotocolKey(request: FastifyRequest): string | undefined {
  const header = request.headers['sec-websocket-protocol'];
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (!raw) return undefined;
  for (const entry of raw.split(',')) {
    const protocol = entry.trim();
    if (protocol.startsWith(KEY_SUBPROTOCOL_PREFIX)) return protocol.slice(KEY_SUBPROTOCOL_PREFIX.length);
  }
  return undefined;
}

export async function websocketController(
  fastify: FastifyInstance,
  deps: WebSocketControllerDeps,
): Promise<void> {
  fastify.get('/ws/events', {
    websocket: true,
    schema: {
      description:
        'WebSocket endpoint for real-time events. Authenticate with the `Authorization: Bearer <key>` or ' +
        '`X-API-Key` header, or (for browsers) the `Sec-WebSocket-Protocol: umg.<key>` subprotocol. ' +
        'A read-only key may listen but not send, and never receives QR codes. ' +
        'The server pings every 30 s and drops clients that do not answer: reconnect and catch up.',
      tags: ['WebSocket'],
      querystring: {
        type: 'object' as const,
        properties: {
          accounts: {
            type: 'string' as const,
            description: 'Comma-separated account IDs to subscribe to (optional, empty = all)',
          },
          token: {
            type: 'string' as const,
            deprecated: true,
            description:
              'Deprecated: API key in the URL ends up in logs. Use the Authorization / X-API-Key header ' +
              'or the `umg.<key>` subprotocol instead.',
          },
        },
      },
    },
  }, (socket, request) => {
    const query = request.query as { accounts?: string; token?: string };

    const headerOrProtocolKey = extractApiKey(request) ?? extractSubprotocolKey(request);
    const providedKey = headerOrProtocolKey ?? query.token;
    if (!headerOrProtocolKey && query.token) {
      request.log.warn(
        { route: '/ws/events' },
        'WebSocket authentication via ?token= is deprecated; use the Authorization / X-API-Key header or the umg.<key> subprotocol',
      );
    }

    const scope = resolveAuthScope(providedKey, { adminKey: deps.apiKey, readKey: deps.readApiKey });
    if (!scope) {
      socket.close(4401, 'Unauthorized: invalid or missing API key');
      return;
    }

    const accounts = query.accounts
      ? query.accounts.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;

    deps.wsBroadcaster.addClient(socket, accounts, scope);
  });
}
