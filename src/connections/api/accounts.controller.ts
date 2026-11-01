import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ChannelAccountRepository } from '../../core/accounts/channel-account.repository.js';
import { hasRequiredCredentials, MISSING_CREDENTIALS_MESSAGE, type ChannelAccount, type AccountStatus } from '../../core/accounts/channel-account.js';
import type { ChannelType, ProviderType } from '../../core/messaging/channel.types.js';
import type { AccountIdentity } from '../../core/accounts/account-identity.js';
import type { CredentialValidatorPort } from '../../core/accounts/credential-validator.port.js';
import type { HealthCheckSchedulerPort } from '../../core/accounts/health-check-scheduler.port.js';
import type { ProviderLookupPort } from '../../core/providers/provider-lookup.port.js';
import type { PairingCodeCapable, ConnectionManagerPort } from '../../core/accounts/connection-manager.port.js';
import { buildDefaultIdentity } from '../../core/accounts/account-identity.factory.js';
import { applyHealthResult } from '../../core/accounts/apply-health-result.js';
import {
  accountResponseSchema,
  errorResponseSchema,
  createAccountBodySchema,
  updateAccountBodySchema,
} from './schemas.js';

/** Validated account data shape returned by the validator */
export interface ValidatedAccountData {
  id: string;
  alias: string;
  channel: string;
  provider: string;
  status: string;
  identity?: Record<string, unknown>;
  credentialsRef?: string;
  credentials?: string;
  providerConfig: Record<string, unknown>;
  conversations?: '*' | string[];
  metadata: {
    owner: string;
    environment: 'production' | 'staging';
    webhookPath?: string;
    rateLimit?: { maxPerMinute: number; maxPerDay: number };
    tags: string[];
  };
}

/** Validated shape of an update: only what the request changes. */
export interface ValidatedAccountUpdate {
  alias?: string;
  provider?: string;
  status?: string;
  identity?: Record<string, unknown>;
  credentialsRef?: string;
  credentials?: string;
  providerConfig?: Record<string, unknown>;
  conversations?: '*' | string[];
  metadata?: Partial<ValidatedAccountData['metadata']>;
}

/** Result of validating an account request body */
export interface ValidationResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface AccountsControllerDeps {
  accountRepository: ChannelAccountRepository;
  credentialValidator: CredentialValidatorPort;
  healthCheckScheduler?: HealthCheckSchedulerPort;
  providerRegistry: ProviderLookupPort;
  /**
   * Subscribe an account to its provider's inbound events. Must be idempotent
   * (the same account is wired at boot, on creation and on every connect).
   * Without it, accounts created at runtime would receive nothing until restart.
   */
  wireAccount?: (account: ChannelAccount) => Promise<void>;
  /** Validate create-account request body (injected to avoid schema library coupling) */
  validateAccountBody: (body: unknown) => ValidationResult<ValidatedAccountData>;
  /** Validate update-account request body: what passes can be written and loaded back at the next start. */
  validateAccountUpdate: (body: unknown) => ValidationResult<ValidatedAccountUpdate>;
}

/**
 * Replaces the body with what the validator returns, or answers 400. It runs before Fastify's schema step
 * because that step coerces: `"todo"` or `5` would arrive here as the valid lists `["todo"]` and `["5"]`.
 */
function validatedBody<T>(validate: (body: unknown) => ValidationResult<T>) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = validate(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Bad Request',
        code: 'INVALID_PAYLOAD',
        message: parsed.error ?? 'Invalid account payload',
      });
    }
    request.body = parsed.data;
  };
}

/** A suspended account must not connect: only reactivating it does, through PUT. */
function accountSuspended(accountId: string) {
  return {
    error: 'Conflict',
    code: 'ACCOUNT_SUSPENDED',
    message: `Account '${accountId}' is suspended. Reactivate it with PUT /api/v1/accounts/${accountId} first.`,
  };
}

function getConnectionInfo(account: ChannelAccount, registry: ProviderLookupPort) {
  const manager = registry.getConnectionManager(account.provider);
  if (!manager) return { managed: false as const };
  const info = manager.getConnectionInfo(account.id);
  return { managed: true as const, status: info.status, qr: info.qr };
}

function sanitizeAccount(account: ChannelAccount, providerRegistry: ProviderLookupPort) {
  const connectionInfo = getConnectionInfo(account, providerRegistry);

  return {
    id: account.id,
    alias: account.alias,
    channel: account.channel,
    provider: account.provider,
    status: account.status,
    identity: account.identity,
    conversations: account.conversations,
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

  /** Wire inbound events for an account; a failure is logged and never blocks the request. */
  async function wire(account: ChannelAccount): Promise<void> {
    try {
      await deps.wireAccount?.(account);
    } catch (err) {
      fastify.log.error(`Failed to wire events for ${account.id}: ${(err as Error).message}`);
    }
  }

  /**
   * The ONLY way this controller opens a connection: wire first (idempotent), then
   * connect. Handlers are forgotten on disconnect, so any connect that skipped the
   * wiring would pair fine and then receive nothing. Wiring comes first so no
   * early event is lost.
   */
  async function connectWired(account: ChannelAccount, manager: ConnectionManagerPort): Promise<void> {
    await wire(account);
    await manager.connect(account.id, account.providerConfig);
  }

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

    return accounts.map((a) => sanitizeAccount(a, deps.providerRegistry));
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

    return sanitizeAccount(account, deps.providerRegistry);
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
    const status = await applyHealthResult(deps.accountRepository, account.id, result);

    return {
      accountId: account.id,
      status: status ?? result.status,
      credentialsConfigured: result.credentialsConfigured,
      detail: result.detail,
      lastChecked: new Date().toISOString(),
    };
  });

  // POST /api/v1/accounts — create a new account
  fastify.post('/api/v1/accounts', {
    preValidation: validatedBody(deps.validateAccountBody),
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
    const data = request.body as ValidatedAccountData;
    const channel = data.channel as ChannelType;

    const account: ChannelAccount = {
      id: data.id,
      alias: data.alias,
      channel,
      provider: data.provider as ProviderType,
      status: data.status as AccountStatus,
      identity: data.identity
        ? ({ channel, ...data.identity } as AccountIdentity)
        : buildDefaultIdentity(channel),
      credentialsRef: data.credentialsRef ?? '',
      credentials: data.credentials,
      providerConfig: data.providerConfig,
      conversations: data.conversations,
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

      await wire(saved);

      // Fire-and-forget health check if credentials are available
      if (saved.credentials || saved.credentialsRef) {
        deps.healthCheckScheduler?.checkAccount(saved.id).catch((err) => {
          fastify.log.warn(`Auto health check failed for ${saved.id}: ${(err as Error).message}`);
        });
      }

      return reply.status(201).send(sanitizeAccount(saved, deps.providerRegistry));
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
    preValidation: validatedBody(deps.validateAccountUpdate),
    schema: {
      description: 'Update an existing messaging account',
      tags: ['Accounts'],
      params: idParamsSchema,
      body: updateAccountBodySchema,
      response: {
        200: accountResponseSchema,
        400: errorResponseSchema,
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

    const credentialsOwner = {
      provider: body.provider ?? existing.provider,
      credentialsRef: body.credentialsRef ?? existing.credentialsRef,
      credentials: body.credentials ?? existing.credentials,
    };
    if (!hasRequiredCredentials(credentialsOwner)) {
      return reply.status(400).send({ error: 'Bad Request', code: 'INVALID_PAYLOAD', message: MISSING_CREDENTIALS_MESSAGE });
    }

    // If identity is provided, ensure channel discriminator is set
    if (body.identity) {
      (body.identity as unknown as Record<string, unknown>)['channel'] = existing.channel;
    }

    const wasSuspended = existing.status === 'suspended';
    const updated = await deps.accountRepository.update(id, body);
    fastify.log.info(`Account updated: ${id}`);

    // Auto health check when credentials change
    if (body.credentials || body.credentialsRef) {
      deps.healthCheckScheduler?.checkAccount(id).catch((err) => {
        fastify.log.warn(`Auto health check failed for ${id}: ${(err as Error).message}`);
      });
    }

    if (!updated) {
      return reply.status(404).send({ error: 'Not Found', code: 'ACCOUNT_NOT_FOUND', message: 'Account not found after update' });
    }

    const manager = deps.providerRegistry.getConnectionManager(updated.provider);
    const isSuspended = updated.status === 'suspended';
    if (manager && !wasSuspended && isSuspended) {
      // An open socket would keep receiving. Closed without a logout: reactivating must not need a new QR.
      manager.closeConnection(id);
    }
    // A suspended account was left out of the boot wiring and connection, and nothing else will open them.
    if (manager && wasSuspended && !isSuspended) {
      connectWired(updated, manager).catch((err) => {
        fastify.log.warn(`Connecting reactivated account ${id} failed: ${(err as Error).message}`);
      });
    }

    return sanitizeAccount(updated, deps.providerRegistry);
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
    const account = await deps.accountRepository.findById(id);

    if (!account) {
      return reply.status(404).send({
        error: 'Not Found',
        code: 'ACCOUNT_NOT_FOUND',
        message: `Account '${id}' not found`,
      });
    }

    // Otherwise its socket would keep receiving and reconnecting with no account behind it, and an
    // account created later with this id would inherit the session. Failing here must not stop the deletion.
    const manager = deps.providerRegistry.getConnectionManager(account.provider);
    try {
      await manager?.disconnect(id);
      await manager?.clearSession?.(id, account.providerConfig);
    } catch (err) {
      fastify.log.warn(`Closing deleted account ${id} failed: ${(err as Error).message}`);
    }

    await deps.accountRepository.remove(id);
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
        409: errorResponseSchema,
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

    const manager = deps.providerRegistry.getConnectionManager(account.provider);
    if (!manager) {
      return reply.status(400).send({
        error: 'Bad Request',
        code: 'NOT_SELF_AUTH',
        message: `Provider '${account.provider}' does not support managed connections. Use credentials instead.`,
      });
    }

    if (account.status === 'suspended') {
      return reply.status(409).send(accountSuspended(account.id));
    }

    await connectWired(account, manager);

    return sanitizeAccount(account, deps.providerRegistry);
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
            description: 'Phone number with country code (e.g. "+34600000001"). If omitted, uses the number from account identity.',
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
        409: errorResponseSchema,
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

    const manager = deps.providerRegistry.getConnectionManager(account.provider);
    if (!manager) {
      return reply.status(400).send({
        error: 'Bad Request',
        code: 'NOT_SELF_AUTH',
        message: `Provider '${account.provider}' does not support pairing codes.`,
      });
    }

    if (account.status === 'suspended') {
      return reply.status(409).send(accountSuspended(account.id));
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

    if (!('requestPairingCode' in manager)) {
      return reply.status(400).send({
        error: 'Bad Request',
        code: 'PAIRING_NOT_SUPPORTED',
        message: `Provider '${account.provider}' does not support pairing codes.`,
      });
    }

    // Ensure connection is started
    if (!manager.hasConnection(account.id)) {
      await connectWired(account, manager);
    }

    try {
      const pairingCode = await (manager as unknown as PairingCodeCapable).requestPairingCode(account.id, phoneNumber);

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

    const manager = deps.providerRegistry.getConnectionManager(account.provider);
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

  // POST /api/v1/accounts/:id/reset — clear the stored session and reconnect (fresh QR)
  fastify.post<{ Params: { id: string } }>('/api/v1/accounts/:id/reset', {
    schema: {
      description:
        'Clear the stored session/credentials and restart the connection so a fresh QR is generated. ' +
        'Use when the stored auth is expired and the account is stuck reconnecting without emitting a QR. ' +
        'After calling this, poll GET /api/v1/accounts/:id to retrieve the new QR code.',
      tags: ['Accounts'],
      params: idParamsSchema,
      response: {
        200: {
          type: 'object',
          properties: {
            accountId: { type: 'string' },
            status: { type: 'string' },
            message: { type: 'string' },
          },
          required: ['accountId', 'status'],
        },
        400: errorResponseSchema,
        404: errorResponseSchema,
        409: errorResponseSchema,
        500: errorResponseSchema,
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

    const manager = deps.providerRegistry.getConnectionManager(account.provider);
    if (!manager) {
      return reply.status(400).send({
        error: 'Bad Request',
        code: 'NOT_SELF_AUTH',
        message: `Provider '${account.provider}' does not support managed connections.`,
      });
    }

    if (account.status === 'suspended') {
      return reply.status(409).send(accountSuspended(account.id));
    }

    const clearSession = manager.clearSession?.bind(manager);
    if (!clearSession) {
      return reply.status(400).send({
        error: 'Bad Request',
        code: 'RESET_NOT_SUPPORTED',
        message: `Provider '${account.provider}' does not support session reset.`,
      });
    }

    try {
      await clearSession(account.id, account.providerConfig);
      await connectWired(account, manager);
    } catch (error) {
      fastify.log.error({ accountId: account.id, err: error }, 'Account session reset failed');
      return reply.status(500).send({
        error: 'Internal Server Error',
        code: 'RESET_FAILED',
        message: error instanceof Error ? error.message : 'Failed to reset session',
      });
    }

    fastify.log.info({ accountId: account.id }, 'Account session reset');

    return {
      accountId: account.id,
      status: 'connecting',
      message: 'Session cleared and reconnecting. Poll GET /api/v1/accounts/:id to retrieve the new QR.',
    };
  });
}

