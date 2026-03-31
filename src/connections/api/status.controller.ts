import type { FastifyInstance } from 'fastify';
import type { ChannelAccountRepository } from '../../core/accounts/channel-account.repository.js';
import type { AdapterFactory } from '../../integrations/adapter.factory.js';
import { messageResultSchema, errorResponseSchema } from './schemas.js';

interface StatusControllerDeps {
  accountRepository: ChannelAccountRepository;
  adapterFactory: AdapterFactory;
}

export async function statusController(
  fastify: FastifyInstance,
  deps: StatusControllerDeps,
): Promise<void> {
  fastify.get<{ Params: { id: string }; Querystring: { accountId?: string } }>(
    '/api/v1/messages/:id/status',
    {
      schema: {
        description: 'Get the delivery status of a sent message',
        tags: ['Messaging'],
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        querystring: {
          type: 'object',
          properties: {
            accountId: {
              type: 'string',
              description: 'Account ID that sent the message',
            },
          },
          required: ['accountId'],
        },
        response: {
          200: messageResultSchema,
          400: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { accountId } = request.query;

      if (!accountId) {
        return reply.status(400).send({
          error: 'Bad Request',
          code: 'MISSING_ACCOUNT_ID',
          message: 'accountId query parameter is required',
        });
      }

      const account = await deps.accountRepository.findById(accountId);
      if (!account) {
        return reply.status(404).send({
          error: 'Not Found',
          code: 'ACCOUNT_NOT_FOUND',
          message: `Account '${accountId}' not found`,
        });
      }

      const adapter = deps.adapterFactory.create(account);
      const status = await adapter.getMessageStatus(id);

      return {
        messageId: status.messageId,
        status: status.status,
        timestamp: status.timestamp.toISOString(),
        providerMessageId: status.providerMessageId,
      };
    },
  );

  fastify.post<{ Params: { id: string }; Body: { accountId: string } }>(
    '/api/v1/messages/:id/read',
    {
      schema: {
        description: 'Mark a message as read',
        tags: ['Messaging'],
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: {
            accountId: { type: 'string', description: 'Account ID that received the message' },
          },
          required: ['accountId'],
        },
        response: {
          200: {
            type: 'object',
            properties: { success: { type: 'boolean' } },
            required: ['success'],
          },
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { accountId } = request.body;

      const account = await deps.accountRepository.findById(accountId);
      if (!account) {
        return reply.status(404).send({
          error: 'Not Found',
          code: 'ACCOUNT_NOT_FOUND',
          message: `Account '${accountId}' not found`,
        });
      }

      const adapter = deps.adapterFactory.create(account);
      await adapter.markAsRead(id);

      return { success: true };
    },
  );
}
