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
  metadata: AccountMetadata;
}
