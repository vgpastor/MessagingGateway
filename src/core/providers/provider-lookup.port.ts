import type { ChannelType, ProviderType } from '../messaging/channel.types.js';
import type { ConnectionManagerPort } from '../accounts/connection-manager.port.js';
import type { InboundWebhookPort } from '../messaging/inbound-webhook.port.js';
import type { ProviderHealthChecker } from '../messaging/provider-health.port.js';
import type { MessagingAdapterFactory } from '../messaging/ports/messaging-adapter.port.js';

/**
 * Port for looking up provider capabilities.
 * Core and connections layers depend on this abstraction;
 * integrations layer provides the implementation (ProviderRegistry).
 */
export interface ProviderLookupPort extends MessagingAdapterFactory {
  /** Get connection manager for a provider (if stateful) */
  getConnectionManager(providerId: ProviderType): ConnectionManagerPort | undefined;
  /** Get inbound adapter for a provider */
  getInboundAdapter(providerId: ProviderType): InboundWebhookPort<unknown, unknown> | undefined;
  /** Get health checker for a provider */
  getHealthChecker(providerId: ProviderType): ProviderHealthChecker | undefined;
  /** List all registered providers */
  listProviders(): Array<{ id: ProviderType; channel: ChannelType; displayName: string }>;
}
