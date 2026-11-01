import type { EventBus } from '../event-bus.js';
import { Events } from '../events.js';
import type { ConnectionUpdatePayload } from '../events.js';
import { getLogger } from '../logger/logger.port.js';
import type { ChannelAccountRepository } from './channel-account.repository.js';

/**
 * Keeps an account's status in line with its connection. A connection that drops changes nothing:
 * the provider is reconnecting, the session is still good, and `connection.status` in the API tells
 * the moment. `auth_expired` is for a session that is really lost, because it makes the router
 * reject sends. `suspended` is the operator's decision, and no connection event overrides it.
 */
export function subscribeAccountStatus(eventBus: EventBus, accounts: ChannelAccountRepository): void {
  eventBus.on<ConnectionUpdatePayload>(Events.CONNECTION_UPDATE, async (event) => {
    const { accountId, status } = event.data;
    const account = await accounts.findById(accountId);
    if (!account || account.status === 'suspended') return;

    if (status === 'connected' && account.status !== 'active') {
      await accounts.update(accountId, { status: 'active' });
      getLogger().info('Status auto-updated to active (connected)', { accountId });
    } else if (status === 'auth_expired' && account.status !== 'auth_expired') {
      await accounts.update(accountId, { status: 'auth_expired' });
      getLogger().warn('Status auto-updated to auth_expired (session revoked)', { accountId });
    }
  });
}
