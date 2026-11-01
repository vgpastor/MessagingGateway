import type { ValidationResult } from '../messaging/provider-health.port.js';
import type { AccountIdentity } from './account-identity.js';
import type { AccountStatus } from './channel-account.js';
import type { ChannelAccountRepository } from './channel-account.repository.js';

/**
 * Records what a health check found, on the account as it is by then, because a check can take a while: it
 * may have been suspended or deleted meanwhile. `suspended` is the operator's decision, and no
 * check overrides it, or the next round would reconnect the account.
 *
 * @returns the account's status after this, undefined if it no longer exists
 */
export async function applyHealthResult(
  accounts: Pick<ChannelAccountRepository, 'observe'>,
  accountId: string,
  result: ValidationResult,
): Promise<AccountStatus | undefined> {
  const updated = await accounts.observe(accountId, (account) => {
    const status = account.status === 'suspended' ? 'suspended' : result.status;
    if (!result.discoveredIdentity && status === account.status) return undefined;
    return {
      status,
      ...(result.discoveredIdentity
        ? { identity: { ...account.identity, ...result.discoveredIdentity } as AccountIdentity }
        : {}),
    };
  });
  return updated?.status;
}
