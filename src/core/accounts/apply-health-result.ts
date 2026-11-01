import type { ValidationResult } from '../messaging/provider-health.port.js';
import type { AccountIdentity } from './account-identity.js';
import type { AccountStatus } from './channel-account.js';
import type { ChannelAccountRepository } from './channel-account.repository.js';

/**
 * Writes what a health check found. Reads the account again because a check can take a while: it
 * may have been suspended or deleted meanwhile. `suspended` is the operator's decision, and no
 * check overrides it, or the next round would reconnect the account.
 *
 * @returns the account's status after this, undefined if it no longer exists
 */
export async function applyHealthResult(
  accounts: Pick<ChannelAccountRepository, 'findById' | 'update'>,
  accountId: string,
  result: ValidationResult,
): Promise<AccountStatus | undefined> {
  const account = await accounts.findById(accountId);
  if (!account) return undefined;

  const status = account.status === 'suspended' ? 'suspended' : result.status;
  if (result.discoveredIdentity || status !== account.status) {
    await accounts.update(accountId, {
      status,
      ...(result.discoveredIdentity
        ? { identity: { ...account.identity, ...result.discoveredIdentity } as AccountIdentity }
        : {}),
    });
  }
  return status;
}
