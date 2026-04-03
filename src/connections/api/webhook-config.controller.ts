import type { FastifyInstance } from 'fastify';
import type { ChannelAccountRepository } from '../../core/accounts/channel-account.repository.js';
import type { WebhookConfigRepository } from '../../core/webhooks/webhook-config.repository.js';
import type { WebhookConfigInput } from '../../core/webhooks/webhook-config.js';
import { errorResponseSchema } from './schemas.js';

interface WebhookConfigDeps {
  accountRepository: ChannelAccountRepository;
  webhookConfigRepo: WebhookConfigRepository;
}

const filterValueSchema = {
  oneOf: [
    { type: 'string' },
    { type: 'number' },
    { type: 'boolean' },
    { type: 'array', items: { type: ['string', 'number', 'boolean'] }, maxItems: 50 },
  ],
};

const filtersSchema = {
  type: 'object' as const,
  properties: {
    include: { type: 'object' as const, additionalProperties: filterValueSchema, maxProperties: 20 },
    exclude: { type: 'object' as const, additionalProperties: filterValueSchema, maxProperties: 20 },
    fromMe: { type: 'boolean' as const },
  },
};

const webhookConfigSchema = {
  type: 'object' as const,
  properties: {
    id: { type: 'string' as const },
    accountId: { type: 'string' as const },
    url: { type: 'string' as const },
    secret: { type: 'string' as const },
    events: { type: 'array' as const, items: { type: 'string' as const } },
    filters: filtersSchema,
    enabled: { type: 'boolean' as const },
    createdAt: { type: 'string' as const, format: 'date-time' },
    updatedAt: { type: 'string' as const, format: 'date-time' },
  },
  required: ['id', 'accountId', 'url', 'events', 'enabled', 'createdAt', 'updatedAt'] as const,
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
    filters: filtersSchema,
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
      description: 'List all webhook configurations across all accounts',
      tags: ['Webhooks Config'],
      response: {
        200: { type: 'array' as const, items: webhookConfigSchema },
      },
    },
  }, async () => {
    return deps.webhookConfigRepo.findAll();
  });

  // GET /api/v1/accounts/:id/webhooks — list webhooks for account
  fastify.get<{ Params: { id: string } }>('/api/v1/accounts/:id/webhooks', {
    schema: {
      description: 'List all webhook configurations for a specific account',
      tags: ['Webhooks Config'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      response: {
        200: { type: 'array' as const, items: webhookConfigSchema },
        404: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const account = await deps.accountRepository.findById(id);
    if (!account) {
      return reply.status(404).send({ error: 'Not Found', code: 'ACCOUNT_NOT_FOUND', message: `Account '${id}' not found` });
    }
    return deps.webhookConfigRepo.findByAccountId(id);
  });

  // POST /api/v1/accounts/:id/webhooks — add a webhook to account
  fastify.post<{ Params: { id: string }; Body: WebhookConfigInput }>('/api/v1/accounts/:id/webhooks', {
    schema: {
      description: 'Add a new webhook to an account. Multiple webhooks per account are supported.',
      tags: ['Webhooks Config'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: webhookConfigInputSchema,
      response: {
        201: webhookConfigSchema,
        404: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const account = await deps.accountRepository.findById(id);
    if (!account) {
      return reply.status(404).send({ error: 'Not Found', code: 'ACCOUNT_NOT_FOUND', message: `Account '${id}' not found` });
    }

    const config = await deps.webhookConfigRepo.add(id, request.body);
    fastify.log.info({ accountId: id, webhookId: config.id, url: config.url }, 'Webhook added');
    return reply.status(201).send(config);
  });

  // PUT /api/v1/webhooks/:webhookId — update a specific webhook
  fastify.put<{ Params: { webhookId: string }; Body: Partial<WebhookConfigInput> }>('/api/v1/webhooks/:webhookId', {
    schema: {
      description: 'Update an existing webhook configuration',
      tags: ['Webhooks Config'],
      params: { type: 'object', properties: { webhookId: { type: 'string' } }, required: ['webhookId'] },
      body: {
        type: 'object' as const,
        properties: webhookConfigInputSchema.properties,
      },
      response: {
        200: webhookConfigSchema,
        404: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const { webhookId } = request.params;
    const updated = await deps.webhookConfigRepo.update(webhookId, request.body);
    if (!updated) {
      return reply.status(404).send({ error: 'Not Found', code: 'WEBHOOK_NOT_FOUND', message: `Webhook '${webhookId}' not found` });
    }
    fastify.log.info({ webhookId, url: updated.url }, 'Webhook updated');
    return updated;
  });

  // DELETE /api/v1/webhooks/:webhookId — delete a specific webhook
  fastify.delete<{ Params: { webhookId: string } }>('/api/v1/webhooks/:webhookId', {
    schema: {
      description: 'Remove a specific webhook configuration',
      tags: ['Webhooks Config'],
      params: { type: 'object', properties: { webhookId: { type: 'string' } }, required: ['webhookId'] },
      response: {
        200: { type: 'object' as const, properties: { deleted: { type: 'boolean' as const }, webhookId: { type: 'string' as const } } },
        404: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const { webhookId } = request.params;
    const deleted = await deps.webhookConfigRepo.remove(webhookId);
    if (!deleted) {
      return reply.status(404).send({ error: 'Not Found', code: 'WEBHOOK_NOT_FOUND', message: `Webhook '${webhookId}' not found` });
    }
    fastify.log.info({ webhookId }, 'Webhook removed');
    return { deleted: true, webhookId };
  });

  // DELETE /api/v1/accounts/:id/webhooks — remove all webhooks for account
  fastify.delete<{ Params: { id: string } }>('/api/v1/accounts/:id/webhooks', {
    schema: {
      description: 'Remove all webhook configurations for an account (falls back to global webhook)',
      tags: ['Webhooks Config'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      response: {
        200: { type: 'object' as const, properties: { removed: { type: 'number' as const }, accountId: { type: 'string' as const } } },
        404: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const account = await deps.accountRepository.findById(id);
    if (!account) {
      return reply.status(404).send({ error: 'Not Found', code: 'ACCOUNT_NOT_FOUND', message: `Account '${id}' not found` });
    }
    const removed = await deps.webhookConfigRepo.removeByAccountId(id);
    return { removed, accountId: id };
  });

  // === Backwards compat: keep old single-webhook endpoints working ===

  // GET /api/v1/accounts/:id/webhook (singular) — returns first webhook or 404
  fastify.get<{ Params: { id: string } }>('/api/v1/accounts/:id/webhook', {
    schema: { hide: true },
  }, async (request, reply) => {
    const configs = await deps.webhookConfigRepo.findByAccountId(request.params.id);
    if (configs.length === 0) {
      return reply.status(404).send({ error: 'Not Found', code: 'WEBHOOK_NOT_CONFIGURED', message: `No webhook configured for account '${request.params.id}'` });
    }
    return configs[0];
  });

  // PUT /api/v1/accounts/:id/webhook (singular) — adds a webhook (compat)
  fastify.put<{ Params: { id: string }; Body: WebhookConfigInput }>('/api/v1/accounts/:id/webhook', {
    schema: { hide: true },
  }, async (request, reply) => {
    const account = await deps.accountRepository.findById(request.params.id);
    if (!account) {
      return reply.status(404).send({ error: 'Not Found', code: 'ACCOUNT_NOT_FOUND', message: `Account '${request.params.id}' not found` });
    }
    // Check if there's already a webhook with same URL — update it; otherwise add new
    const existing = await deps.webhookConfigRepo.findByAccountId(request.params.id);
    const match = existing.find((c) => c.url === request.body.url);
    if (match) {
      return deps.webhookConfigRepo.update(match.id, request.body);
    }
    return reply.status(201).send(await deps.webhookConfigRepo.add(request.params.id, request.body));
  });

  // DELETE /api/v1/accounts/:id/webhook (singular) — removes all (compat)
  fastify.delete<{ Params: { id: string } }>('/api/v1/accounts/:id/webhook', {
    schema: { hide: true },
  }, async (request) => {
    const removed = await deps.webhookConfigRepo.removeByAccountId(request.params.id);
    return { deleted: removed > 0, accountId: request.params.id };
  });
}
