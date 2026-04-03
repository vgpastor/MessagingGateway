import type { FastifyInstance } from 'fastify';
import type { MessageStorePort } from './message-store.port.js';
import { errorResponseSchema } from '../connections/api/schemas.js';

interface MessagesControllerDeps {
  messageStore: MessageStorePort;
}

export async function messagesController(
  fastify: FastifyInstance,
  deps: MessagesControllerDeps,
): Promise<void> {

  fastify.get<{
    Querystring: {
      accountId?: string;
      channel?: string;
      conversationId?: string;
      senderId?: string;
      contentType?: string;
      direction?: string;
      since?: string;
      until?: string;
      limit?: string;
      offset?: string;
    };
  }>('/api/v1/messages', {
    schema: {
      description: 'Query stored messages with filters. Requires STORAGE_ENABLED=true.',
      tags: ['Messages'],
      querystring: {
        type: 'object' as const,
        properties: {
          accountId: { type: 'string' as const },
          channel: { type: 'string' as const },
          conversationId: { type: 'string' as const },
          senderId: { type: 'string' as const },
          contentType: { type: 'string' as const },
          direction: { type: 'string' as const, enum: ['inbound', 'outbound'] },
          since: { type: 'string' as const, format: 'date-time' },
          until: { type: 'string' as const, format: 'date-time' },
          limit: { type: 'string' as const },
          offset: { type: 'string' as const },
        },
      },
    },
  }, async (request) => {
    const q = request.query;
    return deps.messageStore.query({
      accountId: q.accountId,
      channel: q.channel,
      conversationId: q.conversationId,
      senderId: q.senderId,
      contentType: q.contentType,
      direction: q.direction as 'inbound' | 'outbound' | undefined,
      since: q.since ? new Date(q.since) : undefined,
      until: q.until ? new Date(q.until) : undefined,
      limit: q.limit ? parseInt(q.limit, 10) : undefined,
      offset: q.offset ? parseInt(q.offset, 10) : undefined,
    });
  });

  fastify.get<{ Params: { id: string } }>('/api/v1/messages/:id', {
    schema: {
      description: 'Get a stored message by ID',
      tags: ['Messages'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      response: { 404: errorResponseSchema },
    },
  }, async (request, reply) => {
    const msg = await deps.messageStore.findById(request.params.id);
    if (!msg) {
      return reply.status(404).send({ error: 'Not Found', code: 'MESSAGE_NOT_FOUND', message: `Message '${request.params.id}' not found` });
    }
    return msg;
  });

  fastify.get('/api/v1/messages/stats', {
    schema: {
      description: 'Get message count statistics',
      tags: ['Messages'],
      querystring: {
        type: 'object' as const,
        properties: {
          accountId: { type: 'string' as const },
          since: { type: 'string' as const, format: 'date-time' },
        },
      },
    },
  }, async (request) => {
    const q = request.query as { accountId?: string; since?: string };
    const total = await deps.messageStore.count({
      accountId: q.accountId,
      since: q.since ? new Date(q.since) : undefined,
    });
    return { total };
  });
}
