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

  // --- Full-text search ---
  fastify.get<{
    Querystring: {
      q?: string;
      accountId?: string;
      limit?: string;
      offset?: string;
    };
  }>('/api/v1/messages/search', {
    schema: {
      description: 'Full-text search across stored messages. Requires STORAGE_ENABLED=true.',
      tags: ['Messages'],
      querystring: {
        type: 'object' as const,
        properties: {
          q: { type: 'string' as const, description: 'Search query (FTS5 syntax)' },
          accountId: { type: 'string' as const },
          limit: { type: 'string' as const },
          offset: { type: 'string' as const },
        },
        required: ['q'] as const,
      },
    },
  }, async (request, reply) => {
    const q = request.query;
    if (!q.q) {
      return reply.status(400).send({ error: 'Bad Request', code: 'MISSING_QUERY', message: 'Query parameter "q" is required' });
    }
    return deps.messageStore.search(q.q, {
      accountId: q.accountId,
      limit: q.limit ? parseInt(q.limit, 10) : undefined,
      offset: q.offset ? parseInt(q.offset, 10) : undefined,
    });
  });

  // --- Analytics ---
  fastify.get<{
    Querystring: {
      accountId?: string;
      since?: string;
      until?: string;
    };
  }>('/api/v1/messages/analytics', {
    schema: {
      description: 'Returns aggregated message statistics. Requires STORAGE_ENABLED=true.',
      tags: ['Messages'],
      querystring: {
        type: 'object' as const,
        properties: {
          accountId: { type: 'string' as const },
          since: { type: 'string' as const, format: 'date-time' },
          until: { type: 'string' as const, format: 'date-time' },
        },
      },
    },
  }, async (request) => {
    const q = request.query;
    return deps.messageStore.getStats({
      accountId: q.accountId,
      since: q.since ? new Date(q.since) : undefined,
      until: q.until ? new Date(q.until) : undefined,
    });
  });

  // --- Export (CSV / JSON) ---
  fastify.get<{
    Querystring: {
      accountId?: string;
      since?: string;
      until?: string;
      format?: string;
      limit?: string;
      offset?: string;
    };
  }>('/api/v1/messages/export', {
    schema: {
      description: 'Export messages in CSV or JSON format. Requires STORAGE_ENABLED=true.',
      tags: ['Messages'],
      querystring: {
        type: 'object' as const,
        properties: {
          accountId: { type: 'string' as const },
          since: { type: 'string' as const, format: 'date-time' },
          until: { type: 'string' as const, format: 'date-time' },
          format: { type: 'string' as const, enum: ['csv', 'json'], default: 'json' },
          limit: { type: 'string' as const },
          offset: { type: 'string' as const },
        },
      },
    },
  }, async (request, reply) => {
    const q = request.query;
    const result = await deps.messageStore.query({
      accountId: q.accountId,
      since: q.since ? new Date(q.since) : undefined,
      until: q.until ? new Date(q.until) : undefined,
      limit: q.limit ? parseInt(q.limit, 10) : 1000,
      offset: q.offset ? parseInt(q.offset, 10) : undefined,
    });

    if (q.format === 'csv') {
      const headers = ['id', 'timestamp', 'channel', 'direction', 'sender', 'conversation', 'type', 'preview'];
      const csvRows = result.messages.map((m) => {
        const preview = m.content.type === 'text' ? (m.content as any).body?.substring(0, 200) : `[${m.content.type}]`;
        return [
          m.id,
          m.timestamp,
          m.channel,
          m.direction,
          m.sender.displayName,
          m.conversationId,
          m.content.type,
          preview,
        ].map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',');
      });
      const csv = [headers.join(','), ...csvRows].join('\n');

      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="messages.csv"')
        .send(csv);
    }

    return result;
  });
}
