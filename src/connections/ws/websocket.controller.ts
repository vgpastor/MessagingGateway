import type { FastifyInstance } from 'fastify';
import type { WebSocketBroadcaster } from './websocket-broadcaster.js';

interface WebSocketControllerDeps {
  wsBroadcaster: WebSocketBroadcaster;
  apiKey?: string;
}

export async function websocketController(
  fastify: FastifyInstance,
  deps: WebSocketControllerDeps,
): Promise<void> {
  fastify.get('/ws/events', {
    websocket: true,
    schema: {
      description: 'WebSocket endpoint for real-time events. Requires ?token=<API_KEY> when API_KEY is configured.',
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
            description: 'API key for authentication (required when API_KEY is configured)',
          },
        },
      },
    },
  }, (socket, request) => {
    const query = request.query as { accounts?: string; token?: string };

    // Authenticate if API key is configured
    if (deps.apiKey) {
      if (!query.token || query.token !== deps.apiKey) {
        socket.close(4401, 'Unauthorized: invalid or missing token');
        return;
      }
    }

    const accounts = query.accounts
      ? query.accounts.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;

    deps.wsBroadcaster.addClient(socket, accounts);
  });
}
