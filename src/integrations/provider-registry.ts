import type { ChannelAccount } from '../core/accounts/channel-account.js';
import type { ChannelType, ProviderType } from '../core/messaging/channel.types.js';
import type { MessagingPort } from '../core/messaging/messaging.port.js';
import type { MessagingAdapterFactory } from '../core/messaging/ports/messaging-adapter.port.js';
import type { ProviderHealthChecker } from '../core/messaging/provider-health.port.js';
import type { InboundWebhookPort } from '../core/messaging/inbound-webhook.port.js';
import type { ConnectionManagerPort } from '../core/accounts/connection-manager.port.js';
import { AdapterNotFoundError } from '../core/errors.js';

// ── Factory function types for ProviderBundle ───────────────────

export type MessagingFactory = (
  providerConfig: Record<string, unknown>,
  credentialsRef: string,
  inlineCredential?: string,
) => MessagingPort;

export type InboundAdapterFactory = () => InboundWebhookPort<any, any>;

export type HealthAdapterFactory = () => ProviderHealthChecker;

export type ConnectionAdapterFactory = () => ConnectionManagerPort;

// ── ProviderBundle ──────────────────────────────────────────────

export interface ProviderBundle {
  id: ProviderType;
  channel: ChannelType;
  displayName: string;
  messaging: MessagingFactory;
  inbound?: InboundAdapterFactory;
  health?: HealthAdapterFactory;
  connection?: ConnectionAdapterFactory;
}

// ── ProviderRegistry ────────────────────────────────────────────

export class ProviderRegistry implements MessagingAdapterFactory {
  private providers = new Map<ProviderType, ProviderBundle>();

  register(bundle: ProviderBundle): void {
    this.providers.set(bundle.id, bundle);
  }

  get(providerId: ProviderType): ProviderBundle | undefined {
    return this.providers.get(providerId);
  }

  getOrThrow(providerId: ProviderType): ProviderBundle {
    const bundle = this.providers.get(providerId);
    if (!bundle) {
      throw new AdapterNotFoundError(providerId);
    }
    return bundle;
  }

  create(account: ChannelAccount): MessagingPort {
    const bundle = this.getOrThrow(account.provider);
    const providerConfig = { ...account.providerConfig, accountId: account.id };
    return bundle.messaging(providerConfig, account.credentialsRef, account.credentials);
  }

  has(providerId: string): boolean {
    return this.providers.has(providerId as ProviderType);
  }

  getHealthChecker(providerId: ProviderType): ProviderHealthChecker | undefined {
    return this.providers.get(providerId)?.health?.();
  }

  getConnectionManager(providerId: ProviderType): ConnectionManagerPort | undefined {
    return this.providers.get(providerId)?.connection?.();
  }

  getInboundAdapter(providerId: ProviderType): InboundWebhookPort<any, any> | undefined {
    return this.providers.get(providerId)?.inbound?.();
  }

  listProviders(): Array<{ id: ProviderType; channel: ChannelType; displayName: string }> {
    return [...this.providers.values()].map((p) => ({
      id: p.id,
      channel: p.channel,
      displayName: p.displayName,
    }));
  }
}
