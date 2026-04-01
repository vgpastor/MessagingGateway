import type { FastifyInstance } from 'fastify';
import type { ChannelAccountRepository } from '../../../core/accounts/channel-account.repository.js';
import type { WebhookForwarder } from '../../webhooks/webhook-forwarder.js';
import { errorResponseSchema } from '../schemas.js';

interface SmsWebhookDeps {
  accountRepository: ChannelAccountRepository;
  webhookForwarder: WebhookForwarder;
}

export async function smsWebhookController(
  fastify: FastifyInstance,
  deps: SmsWebhookDeps,
): Promise<void> {
  fastify.post<{ Params: { accountId: string }; Body: unknown }>(
    '/webhooks/sms/:accountId/inbound',
    {
      schema: {
        description: 'Receive inbound SMS messages',
        tags: ['Webhooks'],
        params: {
          type: 'object',
          properties: { accountId: { type: 'string' } },
          required: ['accountId'],
        },
        body: {
          type: 'object',
          additionalProperties: true,
        },
        response: {
          200: {
            type: 'object',
            properties: { received: { type: 'boolean' } },
            required: ['received'],
          },
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { accountId } = request.params;

      const account = await deps.accountRepository.findById(accountId);
      if (!account) {
        return reply.status(404).send({
          error: 'Not Found',
          code: 'ACCOUNT_NOT_FOUND',
          message: `Account '${accountId}' not found`,
        });
      }

      if (account.channel !== 'sms') {
        return reply.status(400).send({
          error: 'Bad Request',
          code: 'CHANNEL_MISMATCH',
          message: `Account '${accountId}' is not an SMS account`,
        });
      }

      await deps.webhookForwarder.forwardRaw(accountId, request.body, 'message.inbound', account.channel);

      return { received: true };
    },
  );

  fastify.post<{ Params: { accountId: string }; Body: unknown }>(
    '/webhooks/sms/:accountId/status',
    {
      schema: {
        description: 'Receive SMS delivery status updates',
        tags: ['Webhooks'],
        params: {
          type: 'object',
          properties: { accountId: { type: 'string' } },
          required: ['accountId'],
        },
        body: {
          type: 'object',
          additionalProperties: true,
        },
        response: {
          200: {
            type: 'object',
            properties: { received: { type: 'boolean' } },
            required: ['received'],
          },
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { accountId } = request.params;

      const account = await deps.accountRepository.findById(accountId);
      if (!account) {
        return reply.status(404).send({
          error: 'Not Found',
          code: 'ACCOUNT_NOT_FOUND',
          message: `Account '${accountId}' not found`,
        });
      }

      await deps.webhookForwarder.forwardRaw(accountId, request.body, 'message.status', account.channel);

      return { received: true };
    },
  );
}
