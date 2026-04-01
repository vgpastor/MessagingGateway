import type { FastifyInstance } from 'fastify';
import type { WebSocketBroadcaster } from './websocket-broadcaster.js';

interface WebSocketControllerDeps {
  wsBroadcaster: WebSocketBroadcaster;
}

export async function websocketController(
  fastify: FastifyInstance,
  deps: WebSocketControllerDeps,
): Promise<void> {
  fastify.get('/ws/events', {
    websocket: true,
    schema: {
      description: 'WebSocket endpoint for real-time events. Connect and receive message.inbound, connection.update, message.sent events. Optionally filter by account via query param or subscribe action.',
      tags: ['WebSocket'],
      querystring: {
        type: 'object' as const,
        properties: {
          accounts: {
            type: 'string' as const,
            description: 'Comma-separated account IDs to subscribe to (optional, empty = all)',
          },
        },
      },
    },
  }, (socket, request) => {
    const query = request.query as { accounts?: string };
    const accounts = query.accounts
      ? query.accounts.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;

    deps.wsBroadcaster.addClient(socket, accounts);
  });
}
