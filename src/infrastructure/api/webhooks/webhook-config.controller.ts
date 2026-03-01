import type { FastifyInstance } from 'fastify';
import type { ChannelAccountRepository } from '../../../domain/accounts/channel-account.repository.js';
import type { WebhookConfigRepository } from '../../../domain/webhooks/webhook-config.repository.js';
import type { WebhookConfigInput } from '../../../domain/webhooks/webhook-config.js';
import { errorResponseSchema } from '../schemas.js';

interface WebhookConfigDeps {
  accountRepository: ChannelAccountRepository;
  webhookConfigRepo: WebhookConfigRepository;
}

const webhookConfigSchema = {
  type: 'object' as const,
  properties: {
    accountId: { type: 'string' as const },
    url: { type: 'string' as const },
    secret: { type: 'string' as const },
    events: { type: 'array' as const, items: { type: 'string' as const } },
    enabled: { type: 'boolean' as const },
    createdAt: { type: 'string' as const, format: 'date-time' },
    updatedAt: { type: 'string' as const, format: 'date-time' },
  },
  required: ['accountId', 'url', 'events', 'enabled', 'createdAt', 'updatedAt'] as const,
};

const webhookConfigInputSchema = {
  type: 'object' as const,
  properties: {
    url: { type: 'string' as const, description: 'Callback URL to receive webhooks' },
    secret: { type: 'string' as const, description: 'HMAC-SHA256 secret for signature verification' },
    events: {
      type: 'array' as const,
      items: { type: 'string' as const, enum: ['message.inbound', 'message.status', 'message.sent', '*'] },
      description: 'Event types to forward. Defaults to ["*"]',
    },
    enabled: { type: 'boolean' as const, description: 'Whether this webhook is active. Defaults to true' },
  },
  required: ['url'] as const,
};

export async function webhookConfigController(
  fastify: FastifyInstance,
  deps: WebhookConfigDeps,
): Promise<void> {

  // GET /api/v1/webhooks — list all webhook configs
  fastify.get('/api/v1/webhooks', {
    schema: {
      description: 'List all webhook configurations',
      tags: ['Webhooks Config'],
      response: {
        200: {
          type: 'array' as const,
          items: webhookConfigSchema,
        },
      },
    },
  }, async () => {
    return deps.webhookConfigRepo.findAll();
  });

  // GET /api/v1/accounts/:id/webhook — get webhook config for account
  fastify.get<{ Params: { id: string } }>('/api/v1/accounts/:id/webhook', {
    schema: {
      description: 'Get webhook configuration for a specific account',
      tags: ['Webhooks Config'],
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      response: {
        200: webhookConfigSchema,
        404: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;

    const account = await deps.accountRepository.findById(id);
    if (!account) {
      return reply.status(404).send({
        error: 'Not Found',
        code: 'ACCOUNT_NOT_FOUND',
        message: `Account '${id}' not found`,
      });
    }

    const config = await deps.webhookConfigRepo.findByAccountId(id);
    if (!config) {
      return reply.status(404).send({
        error: 'Not Found',
        code: 'WEBHOOK_NOT_CONFIGURED',
        message: `No webhook configured for account '${id}'`,
      });
    }

    return config;
  });

  // PUT /api/v1/accounts/:id/webhook — create or update webhook config
  fastify.put<{ Params: { id: string }; Body: WebhookConfigInput }>('/api/v1/accounts/:id/webhook', {
    schema: {
      description: 'Create or update webhook configuration for an account',
      tags: ['Webhooks Config'],
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      body: webhookConfigInputSchema,
      response: {
        200: webhookConfigSchema,
        404: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;

    const account = await deps.accountRepository.findById(id);
    if (!account) {
      return reply.status(404).send({
        error: 'Not Found',
        code: 'ACCOUNT_NOT_FOUND',
        message: `Account '${id}' not found`,
      });
    }

    const config = await deps.webhookConfigRepo.upsert(id, request.body);

    fastify.log.info(
      { accountId: id, url: config.url, enabled: config.enabled },
      'Webhook config updated',
    );

    return config;
  });

  // DELETE /api/v1/accounts/:id/webhook — remove webhook config
  fastify.delete<{ Params: { id: string } }>('/api/v1/accounts/:id/webhook', {
    schema: {
      description: 'Remove webhook configuration for an account (falls back to global webhook)',
      tags: ['Webhooks Config'],
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      response: {
        200: {
          type: 'object' as const,
          properties: {
            deleted: { type: 'boolean' as const },
            accountId: { type: 'string' as const },
          },
          required: ['deleted', 'accountId'] as const,
        },
        404: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;

    const account = await deps.accountRepository.findById(id);
    if (!account) {
      return reply.status(404).send({
        error: 'Not Found',
        code: 'ACCOUNT_NOT_FOUND',
        message: `Account '${id}' not found`,
      });
    }

    const deleted = await deps.webhookConfigRepo.remove(id);

    if (deleted) {
      fastify.log.info({ accountId: id }, 'Webhook config removed');
    }

    return { deleted, accountId: id };
  });
}
