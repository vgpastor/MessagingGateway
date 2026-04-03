import type { FastifyInstance } from 'fastify';
import type { ChannelAccountRepository } from '../../../core/accounts/channel-account.repository.js';
import type { ProviderLookupPort } from '../../../core/providers/provider-lookup.port.js';
import type { WebhookForwarder } from '../../webhooks/webhook-forwarder.js';
import { errorResponseSchema, unifiedEnvelopeSchema } from '../schemas.js';

interface WhatsAppWebhookDeps {
  accountRepository: ChannelAccountRepository;
  webhookForwarder: WebhookForwarder;
  providerRegistry: ProviderLookupPort;
}

export async function whatsappWebhookController(
  fastify: FastifyInstance,
  deps: WhatsAppWebhookDeps,
): Promise<void> {
  fastify.post<{ Params: { accountId: string }; Body: unknown }>(
    '/webhooks/whatsapp/:accountId/inbound',
    {
      schema: {
        description: 'Receive inbound WhatsApp messages from external HTTP providers',
        tags: ['Webhooks'],
        params: {
          type: 'object',
          properties: { accountId: { type: 'string' } },
          required: ['accountId'],
        },
        body: { type: 'object', additionalProperties: true },
        response: {
          200: unifiedEnvelopeSchema,
          400: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { accountId } = request.params;

      const account = await deps.accountRepository.findById(accountId);
      if (!account) {
        return reply.status(404).send({
          error: 'Not Found', code: 'ACCOUNT_NOT_FOUND',
          message: `Account '${accountId}' not found`,
        });
      }

      if (account.channel !== 'whatsapp') {
        return reply.status(400).send({
          error: 'Bad Request', code: 'CHANNEL_MISMATCH',
          message: `Account '${accountId}' is not a WhatsApp account`,
        });
      }

      // Managed providers (Baileys) receive messages internally, not via HTTP webhooks
      if (deps.providerRegistry.getConnectionManager(account.provider)) {
        return reply.status(400).send({
          error: 'Bad Request', code: 'INTERNAL_PROVIDER',
          message: `Account '${accountId}' uses a managed provider that receives messages internally.`,
        });
      }

      // Get inbound adapter from registry (no hardcoded WwebjsWebhookAdapter)
      const inboundAdapter = deps.providerRegistry.getInboundAdapter(account.provider);
      if (!inboundAdapter) {
        return reply.status(400).send({
          error: 'Bad Request', code: 'NO_INBOUND_ADAPTER',
          message: `No inbound adapter registered for provider '${account.provider}'`,
        });
      }

      try {
        const event = inboundAdapter.parseIncoming(request.body);
        const envelope = inboundAdapter.toEnvelope(event, account);

        fastify.log.info(
          { messageId: envelope.id, accountId, type: envelope.content.type },
          'WhatsApp inbound message processed',
        );

        await deps.webhookForwarder.forward(envelope);
        return envelope;
      } catch (error) {
        fastify.log.error({ error, accountId }, 'Failed to process WhatsApp inbound webhook');
        return reply.status(400).send({
          error: 'Bad Request', code: 'INVALID_PAYLOAD',
          message: error instanceof Error ? error.message : 'Invalid payload',
        });
      }
    },
  );

  fastify.post<{ Params: { accountId: string }; Body: Record<string, unknown> }>(
    '/webhooks/whatsapp/:accountId/status',
    {
      schema: {
        description: 'Receive WhatsApp message status updates',
        tags: ['Webhooks'],
        params: {
          type: 'object',
          properties: { accountId: { type: 'string' } },
          required: ['accountId'],
        },
        body: { type: 'object', additionalProperties: true },
        response: {
          200: {
            type: 'object',
            properties: {
              received: { type: 'boolean' },
              messageId: { type: 'string' },
              status: { type: 'string' },
            },
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
          error: 'Not Found', code: 'ACCOUNT_NOT_FOUND',
          message: `Account '${accountId}' not found`,
        });
      }

      // Forward raw status payload through EventBus
      await deps.webhookForwarder.forwardRaw(
        account.id,
        request.body,
        'message.status',
        account.channel,
      );

      return { received: true };
    },
  );
}
