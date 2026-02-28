import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ChannelAccount } from '../../domain/accounts/channel-account.js';
import type { AccountIdentity } from '../../domain/accounts/account-identity.js';
import type { ChannelType, ProviderType } from '../../domain/messaging/channel.types.js';
import { accountsConfigSchema } from './accounts.schema.js';
import { hasValidCredential } from './env.config.js';

export function loadAccountsFromYaml(filePath?: string): ChannelAccount[] {
  const resolvedPath = filePath ?? resolve(process.cwd(), 'src/infrastructure/config/accounts.yaml');
  const fileContent = readFileSync(resolvedPath, 'utf-8');
  const rawConfig = parseYaml(fileContent);
  const parsed = accountsConfigSchema.parse(rawConfig);

  return parsed.accounts.map((acc) => mapToChannelAccount(acc));
}

export function validateAccountCredentials(accounts: ChannelAccount[]): ChannelAccount[] {
  return accounts.map((account) => {
    if (account.status !== 'unchecked') return account;

    const valid = hasValidCredential(account.credentialsRef, account.provider);
    return {
      ...account,
      status: valid ? 'active' : 'unchecked',
    };
  });
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
    identity: buildIdentity(channel, raw.identity),
    credentialsRef: raw.credentialsRef,
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
