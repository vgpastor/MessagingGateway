import type { ChannelAccount } from './channel-account.js';
import type { ValidationResult } from '../messaging/provider-health.port.js';

/**
 * Port for credential validation — abstracts infrastructure
 * so the connections layer doesn't depend on concrete validators.
 */
export interface CredentialValidatorPort {
  validate(account: ChannelAccount): Promise<ValidationResult>;
}
