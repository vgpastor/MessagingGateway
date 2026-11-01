import type { ChannelType, ProviderType } from '../messaging/channel.types.js';
import type { AccountIdentity } from './account-identity.js';

export type AccountStatus = 'active' | 'suspended' | 'auth_expired' | 'error' | 'unchecked';

export interface RateLimitConfig {
  maxPerMinute: number;
  maxPerDay: number;
}

export interface AccountMetadata {
  owner: string;
  environment: 'production' | 'staging';
  webhookPath?: string;
  rateLimit?: RateLimitConfig;
  tags: string[];
}

export interface ChannelAccount {
  id: string;
  alias: string;
  channel: ChannelType;
  provider: ProviderType;
  status: AccountStatus;
  identity: AccountIdentity;
  credentialsRef: string;
  credentials?: string;
  providerConfig: Record<string, unknown>;
  /**
   * Inbound conversations (chat/group JIDs) this account keeps. `'*'` or absent
   * means all; a list drops every other conversation before it is stored.
   */
  conversations?: '*' | string[];
  metadata: AccountMetadata;
}

/** Providers that handle auth internally (e.g. QR/pairing code) don't need credentials. */
const SELF_AUTH_PROVIDERS: readonly string[] = ['baileys'];

export const MISSING_CREDENTIALS_MESSAGE = 'Either credentialsRef or credentials must be provided';

/** An account that breaks this rule cannot be loaded back: the next start would fail. */
export function hasRequiredCredentials(
  account: { provider: string; credentialsRef?: string; credentials?: string },
): boolean {
  return SELF_AUTH_PROVIDERS.includes(account.provider) || Boolean(account.credentialsRef || account.credentials);
}
