import type { ChannelAccount, AccountStatus } from '../accounts/channel-account.js';
import type { AccountIdentity } from '../accounts/account-identity.js';

export interface ValidationResult {
  status: AccountStatus;
  credentialsConfigured: boolean;
  detail?: string;
  discoveredIdentity?: Partial<AccountIdentity>;
}

export interface ProviderHealthChecker {
  validate(account: ChannelAccount): Promise<ValidationResult>;
}
