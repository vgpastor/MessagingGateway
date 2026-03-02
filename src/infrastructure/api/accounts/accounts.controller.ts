import type { FastifyInstance } from 'fastify';
import type { ChannelAccountRepository } from '../../../domain/accounts/channel-account.repository.js';
import type { ChannelAccount } from '../../../domain/accounts/channel-account.js';
import type { ChannelType, ProviderType } from '../../../domain/messaging/channel.types.js';
import type { AccountIdentity } from '../../../domain/accounts/account-identity.js';
import type { CredentialValidator } from '../../credential-validator.js';
import type { HealthCheckScheduler } from '../../health-check-scheduler.js';
import type { ConnectionManagerRegistry } from '../../connection-manager.registry.js';
import { accountSchema } from '../../config/accounts.schema.js';
import { buildDefaultIdentity } from '../../config/accounts.loader.js';
import {
  accountResponseSchema,
  errorResponseSchema,
  createAccountBodySchema,
  updateAccountBodySchema,
} from '../schemas.js';

export interface AccountsControllerDeps {
  accountRepository: ChannelAccountRepository;
  credentialValidator: CredentialValidator;
  healthCheckScheduler?: HealthCheckScheduler;
  connectionManagerRegistry: ConnectionManagerRegistry;
}

function sanitizeAccount(account: ChannelAccount, connectionManagerRegistry: ConnectionManagerRegistry) {
  const connectionInfo = connectionManagerRegistry.getConnectionInfo(account.provider, account.id);

  return {
    id: account.id,
    alias: account.alias,
    channel: account.channel,
    provider: account.provider,
    status: account.status,
    identity: account.identity,
    connection: connectionInfo.managed
      ? { managed: true, status: connectionInfo.status, qr: connectionInfo.qr }
      : undefined,
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

  const idParamsSchema = {
    type: 'object' as const,
    properties: { id: { type: 'string' as const } },
    required: ['id'] as const,
  };

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

    return accounts.map((a) => sanitizeAccount(a, deps.connectionManagerRegistry));
  });

  fastify.get<{ Params: { id: string } }>('/api/v1/accounts/:id', {
    schema: {
      description: 'Get details of a specific account, including live connection status and QR code for self-auth providers',
      tags: ['Accounts'],
      params: idParamsSchema,
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

    return sanitizeAccount(account, deps.connectionManagerRegistry);
  });

  fastify.get<{ Params: { id: string } }>('/api/v1/accounts/:id/health', {
    schema: {
      description: 'Check the connection status of a specific account',
      tags: ['Accounts'],
      params: idParamsSchema,
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

    const result = await deps.credentialValidator.validate(account);

    // Auto-update identity and status if discovered from provider
    if (result.discoveredIdentity || result.status !== account.status) {
      await deps.accountRepository.update(account.id, {
        status: result.status,
        ...(result.discoveredIdentity
          ? { identity: { ...account.identity, ...result.discoveredIdentity } as AccountIdentity }
          : {}),
      });
    }

    return {
      accountId: account.id,
      status: result.status,
      credentialsConfigured: result.credentialsConfigured,
      detail: result.detail,
      lastChecked: new Date().toISOString(),
    };
  });

  // POST /api/v1/accounts — create a new account
  fastify.post('/api/v1/accounts', {
    schema: {
      description: 'Create a new messaging account',
      tags: ['Accounts'],
      body: createAccountBodySchema,
      response: {
        201: accountResponseSchema,
        400: errorResponseSchema,
        409: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const body = request.body as Record<string, unknown>;

    const parsed = accountSchema.safeParse(body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Bad Request',
        code: 'INVALID_PAYLOAD',
        message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    }

    const data = parsed.data;
    const channel = data.channel as ChannelType;

    const account: ChannelAccount = {
      id: data.id,
      alias: data.alias,
      channel,
      provider: data.provider as ProviderType,
      status: data.status,
      identity: data.identity
        ? ({ channel, ...data.identity } as AccountIdentity)
        : buildDefaultIdentity(channel),
      credentialsRef: data.credentialsRef ?? '',
      credentials: data.credentials,
      providerConfig: data.providerConfig,
      metadata: {
        owner: data.metadata.owner,
        environment: data.metadata.environment,
        webhookPath: data.metadata.webhookPath ?? `/webhooks/${channel}/${data.id}`,
        rateLimit: data.metadata.rateLimit,
        tags: data.metadata.tags,
      },
    };

    try {
      const saved = await deps.accountRepository.save(account);
      fastify.log.info(`Account created: ${saved.id}`);

      // Fire-and-forget health check if credentials are available
      if (saved.credentials || saved.credentialsRef) {
        deps.healthCheckScheduler?.checkAccount(saved.id).catch((err) => {
          fastify.log.warn(`Auto health check failed for ${saved.id}: ${(err as Error).message}`);
        });
      }

      return reply.status(201).send(sanitizeAccount(saved, deps.connectionManagerRegistry));
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes('already exists')) {
        return reply.status(409).send({
          error: 'Conflict',
          code: 'ACCOUNT_ALREADY_EXISTS',
          message,
        });
      }
      return reply.status(500).send({
        error: 'Internal Server Error',
        code: 'SAVE_FAILED',
        message,
      });
    }
  });

  // PUT /api/v1/accounts/:id — update an existing account
  fastify.put<{ Params: { id: string } }>('/api/v1/accounts/:id', {
    schema: {
      description: 'Update an existing messaging account',
      tags: ['Accounts'],
      params: idParamsSchema,
      body: updateAccountBodySchema,
      response: {
        200: accountResponseSchema,
        404: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const body = request.body as Partial<Omit<ChannelAccount, 'id'>>;

    const existing = await deps.accountRepository.findById(id);
    if (!existing) {
      return reply.status(404).send({
        error: 'Not Found',
        code: 'ACCOUNT_NOT_FOUND',
        message: `Account '${id}' not found`,
      });
    }

    // If identity is provided, ensure channel discriminator is set
    if (body.identity) {
      const channel = (body as Record<string, unknown>)['channel'] ?? existing.channel;
      (body.identity as unknown as Record<string, unknown>)['channel'] = channel;
    }

    const updated = await deps.accountRepository.update(id, body);
    fastify.log.info(`Account updated: ${id}`);

    // Auto health check when credentials change
    if (body.credentials || body.credentialsRef) {
      deps.healthCheckScheduler?.checkAccount(id).catch((err) => {
        fastify.log.warn(`Auto health check failed for ${id}: ${(err as Error).message}`);
      });
    }

    return sanitizeAccount(updated!, deps.connectionManagerRegistry);
  });

  // DELETE /api/v1/accounts/:id — delete an account
  fastify.delete<{ Params: { id: string } }>('/api/v1/accounts/:id', {
    schema: {
      description: 'Delete a messaging account',
      tags: ['Accounts'],
      params: idParamsSchema,
      response: {
        200: {
          type: 'object',
          properties: {
            deleted: { type: 'boolean' },
            accountId: { type: 'string' },
          },
          required: ['deleted', 'accountId'],
        },
        404: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const deleted = await deps.accountRepository.remove(id);

    if (!deleted) {
      return reply.status(404).send({
        error: 'Not Found',
        code: 'ACCOUNT_NOT_FOUND',
        message: `Account '${id}' not found`,
      });
    }

    fastify.log.info(`Account deleted: ${id}`);
    return { deleted: true, accountId: id };
  });

  // ── Connection management (generic for all self-auth providers) ──

  // POST /api/v1/accounts/:id/connect — start connection (QR generation, etc.)
  fastify.post<{ Params: { id: string } }>('/api/v1/accounts/:id/connect', {
    schema: {
      description:
        'Start the connection process for a self-auth provider (e.g. Baileys). ' +
        'After calling this, poll GET /api/v1/accounts/:id to retrieve the QR code.',
      tags: ['Accounts'],
      params: idParamsSchema,
      response: {
        200: accountResponseSchema,
        400: errorResponseSchema,
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

    const manager = deps.connectionManagerRegistry.findFor(account.provider);
    if (!manager) {
      return reply.status(400).send({
        error: 'Bad Request',
        code: 'NOT_SELF_AUTH',
        message: `Provider '${account.provider}' does not support managed connections. Use credentials instead.`,
      });
    }

    await manager.connect(account.id, account.providerConfig);

    return sanitizeAccount(account, deps.connectionManagerRegistry);
  });

  // POST /api/v1/accounts/:id/pair — request pairing code
  fastify.post<{ Params: { id: string }; Body: { phoneNumber?: string } }>('/api/v1/accounts/:id/pair', {
    schema: {
      description:
        'Request a pairing code for authentication. ' +
        'Enter this code in WhatsApp > Linked Devices > Link with phone number.',
      tags: ['Accounts'],
      params: idParamsSchema,
      body: {
        type: 'object',
        properties: {
          phoneNumber: {
            type: 'string',
            description: 'Phone number with country code (e.g. "+14155550004"). If omitted, uses the number from account identity.',
          },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            accountId: { type: 'string' },
            pairingCode: { type: 'string', description: 'Enter this code in the messaging app to link' },
          },
          required: ['accountId', 'pairingCode'],
        },
        400: errorResponseSchema,
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

    const manager = deps.connectionManagerRegistry.findFor(account.provider);
    if (!manager) {
      return reply.status(400).send({
        error: 'Bad Request',
        code: 'NOT_SELF_AUTH',
        message: `Provider '${account.provider}' does not support pairing codes.`,
      });
    }

    const phoneNumber = request.body?.phoneNumber
      ?? (account.identity?.channel === 'whatsapp' ? account.identity.phoneNumber : undefined);

    if (!phoneNumber) {
      return reply.status(400).send({
        error: 'Bad Request',
        code: 'MISSING_PHONE',
        message: 'Phone number is required. Provide it in the request body or configure it in the account identity.',
      });
    }

    // Ensure connection is started
    if (!manager.hasConnection(account.id)) {
      await manager.connect(account.id, account.providerConfig);
    }

    try {
      const pairingCode = await manager.requestPairingCode(account.id, phoneNumber);

      fastify.log.info(
        { accountId: account.id, phoneNumber },
        'Pairing code requested',
      );

      return { accountId: account.id, pairingCode };
    } catch (error) {
      return reply.status(400).send({
        error: 'Bad Request',
        code: 'PAIRING_FAILED',
        message: error instanceof Error ? error.message : 'Failed to request pairing code',
      });
    }
  });

  // POST /api/v1/accounts/:id/disconnect — disconnect and clear session
  fastify.post<{ Params: { id: string } }>('/api/v1/accounts/:id/disconnect', {
    schema: {
      description: 'Disconnect a self-auth provider account and clear its session',
      tags: ['Accounts'],
      params: idParamsSchema,
      response: {
        200: {
          type: 'object',
          properties: {
            accountId: { type: 'string' },
            status: { type: 'string' },
          },
          required: ['accountId', 'status'],
        },
        400: errorResponseSchema,
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

    const manager = deps.connectionManagerRegistry.findFor(account.provider);
    if (!manager) {
      return reply.status(400).send({
        error: 'Bad Request',
        code: 'NOT_SELF_AUTH',
        message: `Provider '${account.provider}' does not support managed connections.`,
      });
    }

    await manager.disconnect(account.id);
    fastify.log.info({ accountId: account.id }, 'Account disconnected');

    return { accountId: account.id, status: 'disconnected' };
  });
}
