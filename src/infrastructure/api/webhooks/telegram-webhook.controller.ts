import type { FastifyInstance } from 'fastify';
import type { ChannelAccountRepository } from '../../../domain/accounts/channel-account.repository.js';
import type { WebhookForwarder } from '../../webhook-forwarder.js';
import { errorResponseSchema } from '../schemas.js';

interface TelegramWebhookDeps {
  accountRepository: ChannelAccountRepository;
  webhookForwarder: WebhookForwarder;
}

export async function telegramWebhookController(
  fastify: FastifyInstance,
  deps: TelegramWebhookDeps,
): Promise<void> {
  fastify.post<{ Params: { accountId: string }; Body: unknown }>(
    '/webhooks/telegram/:accountId/update',
    {
      schema: {
        description: 'Receive Telegram Bot API updates',
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

      if (account.channel !== 'telegram') {
        return reply.status(400).send({
          error: 'Bad Request',
          code: 'CHANNEL_MISMATCH',
          message: `Account '${accountId}' is not a Telegram account`,
        });
      }

      fastify.log.info({ accountId }, 'Telegram update received (adapter not yet implemented)');

      return { received: true };
    },
  );
}
