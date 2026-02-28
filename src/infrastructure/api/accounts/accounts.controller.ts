import type { FastifyInstance } from 'fastify';
import type { ChannelAccountRepository } from '../../../domain/accounts/channel-account.repository.js';
import type { ChannelAccount } from '../../../domain/accounts/channel-account.js';
import { accountResponseSchema, errorResponseSchema } from '../schemas.js';
import { validateAccount } from '../../credential-validator.js';

interface AccountsControllerDeps {
  accountRepository: ChannelAccountRepository;
}

function sanitizeAccount(account: ChannelAccount) {
  return {
    id: account.id,
    alias: account.alias,
    channel: account.channel,
    provider: account.provider,
    status: account.status,
    identity: account.identity,
    metadata: {
      owner: account.metadata.owner,
      environment: account.metadata.environment,
      webhookPath: account.metadata.webhookPath,
      tags: account.metadata.tags,
    },
  };
}

export async function accountsController(
  fastify: FastifyInstance,
  deps: AccountsControllerDeps,
): Promise<void> {
  fastify.get('/api/v1/accounts', {
    schema: {
      description: 'List all configured messaging accounts',
      tags: ['Accounts'],
      querystring: {
        type: 'object',
        properties: {
          channel: { type: 'string', enum: ['whatsapp', 'telegram', 'email', 'sms'] },
          owner: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'array',
          items: accountResponseSchema,
        },
      },
    },
  }, async (request) => {
    const query = request.query as { channel?: string; owner?: string };

    let accounts: ChannelAccount[];

    if (query.channel) {
      accounts = await deps.accountRepository.findByChannel(query.channel as ChannelAccount['channel']);
    } else if (query.owner) {
      accounts = await deps.accountRepository.findByOwner(query.owner);
    } else {
      accounts = await deps.accountRepository.findAll();
    }

    return accounts.map(sanitizeAccount);
  });

  fastify.get<{ Params: { id: string } }>('/api/v1/accounts/:id', {
    schema: {
      description: 'Get details of a specific account',
      tags: ['Accounts'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
      response: {
        200: accountResponseSchema,
        404: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const account = await deps.accountRepository.findById(request.params.id);

    if (!account) {
      return reply.status(404).send({
        error: 'Not Found',
        code: 'ACCOUNT_NOT_FOUND',
        message: `Account '${request.params.id}' not found`,
      });
    }

    return sanitizeAccount(account);
  });

  fastify.get<{ Params: { id: string } }>('/api/v1/accounts/:id/health', {
    schema: {
      description: 'Check the connection status of a specific account',
      tags: ['Accounts'],
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      response: {
        200: {
          type: 'object',
          properties: {
            accountId: { type: 'string' },
            status: { type: 'string', enum: ['active', 'suspended', 'auth_expired', 'error', 'unchecked'] },
            credentialsConfigured: { type: 'boolean' },
            detail: { type: 'string' },
            lastChecked: { type: 'string', format: 'date-time' },
          },
          required: ['accountId', 'status', 'credentialsConfigured', 'lastChecked'],
        },
        404: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const account = await deps.accountRepository.findById(request.params.id);

    if (!account) {
      return reply.status(404).send({
        error: 'Not Found',
        code: 'ACCOUNT_NOT_FOUND',
        message: `Account '${request.params.id}' not found`,
      });
    }

    const result = await validateAccount(account);

    return {
      accountId: account.id,
      status: result.status,
      credentialsConfigured: result.credentialsConfigured,
      detail: result.detail,
      lastChecked: new Date().toISOString(),
    };
  });
}
