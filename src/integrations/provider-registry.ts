import type { ChannelAccount } from '../core/accounts/channel-account.js';
import type { ChannelType, ProviderType } from '../core/messaging/channel.types.js';
import type { MessagingPort } from '../core/messaging/messaging.port.js';
import type { ProviderHealthChecker } from '../core/messaging/provider-health.port.js';
import type { InboundWebhookPort } from '../core/messaging/inbound-webhook.port.js';
import type { ConnectionManagerPort } from '../core/accounts/connection-manager.port.js';
import { AdapterNotFoundError } from '../core/errors.js';

// ── Factory function types ──────────────────────────────────────

export type MessagingAdapterFactory = (
  providerConfig: Record<string, unknown>,
  credentialsRef: string,
  inlineCredential?: string,
) => MessagingPort;

export type InboundAdapterFactory = () => InboundWebhookPort<any, any>;

export type HealthAdapterFactory = () => ProviderHealthChecker;

export type ConnectionAdapterFactory = () => ConnectionManagerPort;

// ── ProviderBundle ──────────────────────────────────────────────

export interface ProviderBundle {
  /** Unique provider identifier, e.g. 'baileys', 'wwebjs-api' */
  id: ProviderType;
  /** Channel this provider operates on */
  channel: ChannelType;
  /** Human-readable name */
  displayName: string;
  /** Factory for outbound messaging adapter */
  messaging: MessagingAdapterFactory;
  /** Factory for inbound webhook adapter */
  inbound?: InboundAdapterFactory;
  /** Factory for credential/connection health checks */
  health?: HealthAdapterFactory;
  /** Factory for stateful connection management (Baileys, etc.) */
  connection?: ConnectionAdapterFactory;
}

// ── ProviderRegistry ────────────────────────────────────────────

export class ProviderRegistry {
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

  /** Create a MessagingPort for the given account */
  createMessagingAdapter(account: ChannelAccount): MessagingPort {
    const bundle = this.getOrThrow(account.provider);
    const providerConfig = { ...account.providerConfig, accountId: account.id };
    return bundle.messaging(providerConfig, account.credentialsRef, account.credentials);
  }

  /** Get health checker for a provider */
  getHealthChecker(providerId: ProviderType): ProviderHealthChecker | undefined {
    return this.providers.get(providerId)?.health?.();
  }

  /** Get connection manager for a provider (if stateful) */
  getConnectionManager(providerId: ProviderType): ConnectionManagerPort | undefined {
    return this.providers.get(providerId)?.connection?.();
  }

  /** Get inbound adapter for a provider */
  getInboundAdapter(providerId: ProviderType): InboundWebhookPort<any, any> | undefined {
    return this.providers.get(providerId)?.inbound?.();
  }

  /** List all registered providers */
  listProviders(): Array<{ id: ProviderType; channel: ChannelType; displayName: string }> {
    return [...this.providers.values()].map((p) => ({
      id: p.id,
      channel: p.channel,
      displayName: p.displayName,
    }));
  }

  has(providerId: ProviderType): boolean {
    return this.providers.has(providerId);
  }
}
