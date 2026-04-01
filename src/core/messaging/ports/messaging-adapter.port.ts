import type { ChannelAccount } from '../../accounts/channel-account.js';
import type { MessagingPort } from '../messaging.port.js';

/**
 * Port for creating messaging adapters from account configuration.
 * Core depends on this abstraction; integrations layer provides the implementation.
 */
export interface MessagingAdapterFactory {
  create(account: ChannelAccount): MessagingPort;
  has(provider: string): boolean;
}
