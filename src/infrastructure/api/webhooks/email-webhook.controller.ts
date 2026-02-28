import type { FastifyInstance } from 'fastify';
import type { ChannelAccountRepository } from '../../../domain/accounts/channel-account.repository.js';
import type { WebhookForwarder } from '../../webhook-forwarder.js';
import { errorResponseSchema } from '../schemas.js';

interface EmailWebhookDeps {
  accountRepository: ChannelAccountRepository;
  webhookForwarder: WebhookForwarder;
}

export async function emailWebhookController(
  fastify: FastifyInstance,
  deps: EmailWebhookDeps,
): Promise<void> {
  fastify.post<{ Params: { accountId: string }; Body: unknown }>(
    '/webhooks/email/:accountId/inbound',
    {
      schema: {
        description: 'Receive inbound email webhooks (Brevo/SES)',
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

      if (account.channel !== 'email') {
        return reply.status(400).send({
          error: 'Bad Request',
          code: 'CHANNEL_MISMATCH',
          message: `Account '${accountId}' is not an email account`,
        });
      }

      fastify.log.info({ accountId }, 'Email inbound received (adapter not yet implemented)');

      return { received: true };
    },
  );
}
