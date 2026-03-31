// Re-export from core — this file exists for backwards compatibility
export type {
  ChannelAccount,
  AccountStatus,
  AccountMetadata,
  RateLimitConfig,
} from '../../core/accounts/channel-account.js';
export type {
  AccountIdentity,
  WhatsAppIdentity,
  TelegramIdentity,
  EmailIdentity,
  SmsIdentity,
} from '../../core/accounts/account-identity.js';
export type { ChannelAccountRepository } from '../../core/accounts/channel-account.repository.js';
