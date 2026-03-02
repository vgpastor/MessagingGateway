import type { FastifyInstance } from 'fastify';
import type { ChannelAccountRepository } from '../../../domain/accounts/channel-account.repository.js';
import { WwebjsWebhookAdapter } from '../../../adapters/whatsapp/wwebjs-api/wwebjs-webhook.adapter.js';
import { BaileysWebhookAdapter } from '../../../adapters/whatsapp/baileys/baileys-webhook.adapter.js';
import type { WwebjsInboundPayload, WwebjsStatusPayload } from '../../../adapters/whatsapp/wwebjs-api/wwebjs.types.js';
import type { WebhookForwarder } from '../../webhook-forwarder.js';
import { errorResponseSchema, unifiedEnvelopeSchema } from '../schemas.js';

interface WhatsAppWebhookDeps {
  accountRepository: ChannelAccountRepository;
  webhookForwarder: WebhookForwarder;
}

export async function whatsappWebhookController(
  fastify: FastifyInstance,
  deps: WhatsAppWebhookDeps,
): Promise<void> {
  const wwebjsWebhookAdapter = new WwebjsWebhookAdapter();
  const baileysWebhookAdapter = new BaileysWebhookAdapter();

  fastify.post<{ Params: { accountId: string }; Body: WwebjsInboundPayload }>(
    '/webhooks/whatsapp/:accountId/inbound',
    {
      schema: {
        description: 'Receive inbound WhatsApp messages from wwebjs-api or Baileys',
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
          200: unifiedEnvelopeSchema,
          404: errorResponseSchema,
          400: errorResponseSchema,
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

      if (account.channel !== 'whatsapp') {
        return reply.status(400).send({
          error: 'Bad Request',
          code: 'CHANNEL_MISMATCH',
          message: `Account '${accountId}' is not a WhatsApp account`,
        });
      }

      try {
        const event = account.provider === 'baileys'
          ? baileysWebhookAdapter.parseIncoming(request.body as unknown as Parameters<typeof baileysWebhookAdapter.parseIncoming>[0])
          : wwebjsWebhookAdapter.parseIncoming(request.body);
        const envelope = wwebjsWebhookAdapter.toEnvelope(event, account);

        fastify.log.info(
          { messageId: envelope.id, accountId, type: envelope.contentSummary.type },
          'WhatsApp inbound message processed',
        );

        await deps.webhookForwarder.forward(envelope);

        return envelope;
      } catch (error) {
        fastify.log.error({ error, accountId }, 'Failed to process WhatsApp inbound webhook');
        return reply.status(400).send({
          error: 'Bad Request',
          code: 'INVALID_PAYLOAD',
          message: error instanceof Error ? error.message : 'Invalid payload',
        });
      }
    },
  );

  fastify.post<{ Params: { accountId: string }; Body: WwebjsStatusPayload }>(
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
        body: {
          type: 'object',
          additionalProperties: true,
        },
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
          error: 'Not Found',
          code: 'ACCOUNT_NOT_FOUND',
          message: `Account '${accountId}' not found`,
        });
      }

      const statusMap: Record<number, string> = {
        1: 'sent',
        2: 'delivered',
        3: 'read',
        4: 'played',
        5: 'failed',
      };

      const data = request.body.data;
      const status = statusMap[data.status] ?? 'unknown';
      const messageId = data.id._serialized;

      fastify.log.info(
        { messageId, accountId, status },
        'WhatsApp status update received',
      );

      await deps.webhookForwarder.forwardRaw(
        account.id,
        {
          id: `status-${messageId}-${Date.now()}`,
          accountId: account.id,
          channel: account.channel,
          messageId,
          status,
          timestamp: new Date(data.timestamp * 1000),
          error: data.error,
          channelPayload: request.body,
        },
        'message.status',
        account.channel,
      );

      return {
        received: true,
        messageId,
        status,
      };
    },
  );
}
