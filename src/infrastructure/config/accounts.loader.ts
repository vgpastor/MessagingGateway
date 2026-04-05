import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { getLogger } from '../../core/logger/logger.port.js';
import type { ChannelAccount } from '../../core/accounts/channel-account.js';
import type { AccountIdentity } from '../../core/accounts/account-identity.js';
import type { ChannelType, ProviderType } from '../../core/messaging/channel.types.js';
import { buildDefaultIdentity } from '../../core/accounts/account-identity.factory.js';
import { accountsConfigSchema } from './accounts.schema.js';

export function loadAccountsFromYaml(filePath?: string): ChannelAccount[] {
  const resolvedPath = filePath ?? resolve(process.cwd(), 'data/accounts.yaml');

  if (!existsSync(resolvedPath) || !statSync(resolvedPath).isFile()) {
    getLogger().warn('Accounts config not found, starting with 0 accounts', { path: resolvedPath });
    return [];
  }

  const fileContent = readFileSync(resolvedPath, 'utf-8');
  const rawConfig = parseYaml(fileContent);

  if (!rawConfig || !rawConfig.accounts || rawConfig.accounts.length === 0) {
    getLogger().warn('Accounts config is empty, starting with 0 accounts');
    return [];
  }

  const parsed = accountsConfigSchema.parse(rawConfig);

  return parsed.accounts.map((acc) => mapToChannelAccount(acc));
}

function mapToChannelAccount(
  raw: ReturnType<typeof accountsConfigSchema.parse>['accounts'][number],
): ChannelAccount {
  const channel = raw.channel as ChannelType;

  return {
    id: raw.id,
    alias: raw.alias,
    channel,
    provider: raw.provider as ProviderType,
    status: raw.status,
    identity: raw.identity ? buildIdentity(channel, raw.identity) : buildDefaultIdentity(channel),
    credentialsRef: raw.credentialsRef ?? '',
    credentials: raw.credentials,
    providerConfig: raw.providerConfig,
    metadata: {
      owner: raw.metadata.owner,
      environment: raw.metadata.environment,
      webhookPath: raw.metadata.webhookPath ?? `/webhooks/${channel}/${raw.id}`,
      rateLimit: raw.metadata.rateLimit,
      tags: raw.metadata.tags,
    },
  };
}

// Re-export for backwards compatibility
export { buildDefaultIdentity } from '../../core/accounts/account-identity.factory.js';

function buildIdentity(
  channel: ChannelType,
  raw: Record<string, unknown>,
): AccountIdentity {
  switch (channel) {
    case 'whatsapp':
      return {
        channel: 'whatsapp',
        phoneNumber: raw['phoneNumber'] as string,
        wid: raw['wid'] as string | undefined,
      };
    case 'telegram':
      return {
        channel: 'telegram',
        botId: raw['botId'] as string | undefined,
        botUsername: raw['botUsername'] as string,
      };
    case 'email':
      return {
        channel: 'email',
        address: raw['address'] as string,
        domain: raw['domain'] as string | undefined,
      };
    case 'sms':
      return {
        channel: 'sms',
        phoneNumber: raw['phoneNumber'] as string,
        senderId: raw['senderId'] as string | undefined,
      };
  }
}
