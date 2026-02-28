import type { ChannelAccount, AccountStatus } from '../accounts/channel-account.js';

export interface ValidationResult {
  status: AccountStatus;
  credentialsConfigured: boolean;
  detail?: string;
}

export interface ProviderHealthChecker {
  validate(account: ChannelAccount): Promise<ValidationResult>;
}
