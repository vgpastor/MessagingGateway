import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ChannelAccountRepository } from '../../core/accounts/channel-account.repository.js';
import type { AccountStatus, ChannelAccount } from '../../core/accounts/channel-account.js';
import type { ProviderLookupPort } from '../../core/providers/provider-lookup.port.js';

const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8')) as { version: string };

export interface HealthControllerDeps {
  accountRepository: ChannelAccountRepository;
  providerRegistry: ProviderLookupPort;
}

/** `suspended` is set on purpose by the operator, so it must not raise an alarm. */
const DELIBERATELY_DISABLED: ReadonlySet<AccountStatus> = new Set<AccountStatus>(['suspended']);

export async function healthController(fastify: FastifyInstance, deps: HealthControllerDeps): Promise<void> {
  /** An active account keeps its status through a cut, so its live connection counts too. */
  const isDown = (account: ChannelAccount): boolean => {
    if (DELIBERATELY_DISABLED.has(account.status)) return false;
    if (account.status !== 'active') return true;
    const manager = deps.providerRegistry.getConnectionManager(account.provider);
    return manager !== undefined && manager.getConnectionInfo(account.id).status !== 'connected';
  };

  fastify.get('/health', {
    schema: {
      description:
        'Health check endpoint. Public, so it reports the general state only. Always answers 200 (Docker healthcheck); '
        + '`status` is `degraded` when any account that is not deliberately suspended is not `active` or has lost its '
        + 'connection. The detail per account is in GET /api/v1/accounts, with an API key.',
      tags: ['Health'],
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['ok', 'degraded'] },
            timestamp: { type: 'string', format: 'date-time' },
            version: { type: 'string' },
            uptime: { type: 'number' },
          },
          required: ['status', 'timestamp'],
        },
      },
    },
  }, async () => {
    const accounts = await deps.accountRepository.findAll();
    return {
      status: accounts.some(isDown) ? 'degraded' : 'ok',
      timestamp: new Date().toISOString(),
      version: pkg.version,
      uptime: process.uptime(),
    };
  });
}
