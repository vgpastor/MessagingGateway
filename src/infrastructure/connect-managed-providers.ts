import { getLogger } from '../core/logger/logger.port.js';
import type { ChannelAccount } from '../core/accounts/channel-account.js';
import type { EventBus } from '../core/event-bus.js';
import type { InboundPipeline } from '../core/inbound/inbound-pipeline.js';
import type { ProviderRegistry } from '../integrations/provider-registry.js';

/**
 * Connect managed providers (e.g. Baileys) and wire their inbound events.
 *
 * Wiring is independent of the connect outcome: subscriptions belong to the
 * account (not to a socket), so an account whose first connect fails still has
 * its handlers in place when the health checker or a retry brings it online
 * later. Skipping the wiring on a failed connect used to leave such an account
 * connected but deaf. Wiring also runs BEFORE connecting so no early event is lost.
 */
export async function connectManagedProviders(
  accounts: ChannelAccount[],
  providerRegistry: ProviderRegistry,
  eventBus: EventBus,
  inboundPipeline: InboundPipeline,
): Promise<void> {
  const logger = getLogger();
  const managedAccounts = accounts.filter(
    (a) => providerRegistry.get(a.provider)?.connection && (a.status === 'active' || a.status === 'unchecked' || a.status === 'auth_expired'),
  );

  for (const account of managedAccounts) {
    const bundle = providerRegistry.getOrThrow(account.provider);
    const context = { provider: account.provider, accountId: account.id };

    let wired = true;
    if (bundle.wireEvents) {
      try {
        await bundle.wireEvents(account, eventBus, inboundPipeline);
      } catch (err) {
        wired = false;
        logger.error('Failed to wire events', { ...context, error: err instanceof Error ? err.message : String(err) });
      }
    }

    try {
      await bundle.connection!().connect(account.id, account.providerConfig);
      if (wired) {
        logger.info('Connected and listening for messages', context);
      }
    } catch (err) {
      logger.error('Failed to connect', { ...context, error: err instanceof Error ? err.message : String(err) });
    }
  }
}
