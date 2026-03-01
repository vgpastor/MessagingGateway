import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ChannelAccount } from '../../domain/accounts/channel-account.js';
import type { AccountIdentity } from '../../domain/accounts/account-identity.js';
import type { ChannelType, ProviderType } from '../../domain/messaging/channel.types.js';
import { accountsConfigSchema } from './accounts.schema.js';

export function loadAccountsFromYaml(filePath?: string): ChannelAccount[] {
  const resolvedPath = filePath ?? resolve(process.cwd(), 'config/accounts.yaml');

  if (!existsSync(resolvedPath) || !statSync(resolvedPath).isFile()) {
    console.warn(`Accounts config not found at ${resolvedPath}, starting with 0 accounts`);
    return [];
  }

  const fileContent = readFileSync(resolvedPath, 'utf-8');
  const rawConfig = parseYaml(fileContent);

  if (!rawConfig || !rawConfig.accounts || rawConfig.accounts.length === 0) {
    console.warn('Accounts config is empty, starting with 0 accounts');
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

export function buildDefaultIdentity(channel: ChannelType): AccountIdentity {
  switch (channel) {
    case 'whatsapp': return { channel: 'whatsapp', phoneNumber: '' };
    case 'telegram': return { channel: 'telegram', botUsername: '' };
    case 'email': return { channel: 'email', address: '' };
    case 'sms': return { channel: 'sms', phoneNumber: '' };
  }
}

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
