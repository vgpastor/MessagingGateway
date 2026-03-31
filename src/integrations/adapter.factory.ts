import type { ChannelAccount } from '../domain/accounts/channel-account.js';
import type { ProviderType } from '../domain/messaging/channel.types.js';
import type { MessagingPort } from '../domain/messaging/messaging.port.js';
import { AdapterNotFoundError } from '../domain/errors.js';

export type AdapterConstructor = new (
  providerConfig: Record<string, unknown>,
  credentialsRef: string,
  inlineCredential?: string,
) => MessagingPort;

export class AdapterFactory {
  private registry = new Map<ProviderType, AdapterConstructor>();

  register(provider: ProviderType, adapterClass: AdapterConstructor): void {
    this.registry.set(provider, adapterClass);
  }

  create(account: ChannelAccount): MessagingPort {
    const AdapterClass = this.registry.get(account.provider);
    if (!AdapterClass) {
      throw new AdapterNotFoundError(account.provider);
    }
    const providerConfig = { ...account.providerConfig, accountId: account.id };
    return new AdapterClass(providerConfig, account.credentialsRef, account.credentials);
  }

  hasAdapter(provider: ProviderType): boolean {
    return this.registry.has(provider);
  }
}
