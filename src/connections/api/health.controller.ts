import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ChannelAccountRepository } from '../../core/accounts/channel-account.repository.js';
import type { AccountStatus } from '../../core/accounts/channel-account.js';

const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8')) as { version: string };

export interface HealthControllerDeps {
  accountRepository: ChannelAccountRepository;
}

/** `suspended` is set on purpose by the operator, so it must not raise an alarm. */
const DELIBERATELY_DISABLED: ReadonlySet<AccountStatus> = new Set<AccountStatus>(['suspended']);

export async function healthController(fastify: FastifyInstance, deps: HealthControllerDeps): Promise<void> {
  fastify.get('/health', {
    schema: {
      description:
        'Health check endpoint. Always answers 200 (Docker healthcheck); `status` is `degraded` when any account '
        + 'that is not deliberately suspended is not `active`. `accounts` maps each account id to its status.',
      tags: ['Health'],
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['ok', 'degraded'] },
            timestamp: { type: 'string', format: 'date-time' },
            version: { type: 'string' },
            uptime: { type: 'number' },
            accounts: {
              type: 'object',
              additionalProperties: {
                type: 'string',
                enum: ['active', 'suspended', 'auth_expired', 'error', 'unchecked'],
              },
            },
          },
          required: ['status', 'timestamp', 'accounts'],
        },
      },
    },
  }, async () => {
    const accounts = await deps.accountRepository.findAll();
    const statuses: Record<string, AccountStatus> = {};
    for (const account of accounts) statuses[account.id] = account.status;

    const degraded = accounts.some((a) => a.status !== 'active' && !DELIBERATELY_DISABLED.has(a.status));
    return {
      status: degraded ? 'degraded' : 'ok',
      timestamp: new Date().toISOString(),
      version: pkg.version,
      uptime: process.uptime(),
      accounts: statuses,
    };
  });
}
