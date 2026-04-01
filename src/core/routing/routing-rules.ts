import type { ChannelAccount } from '../accounts/channel-account.js';
import type { RoutingCriteria } from '../messaging/outbound-message.js';

export type { RoutingCriteria };

export function matchesRoutingCriteria(
  account: ChannelAccount,
  criteria: RoutingCriteria,
): boolean {
  if (criteria.channel && account.channel !== criteria.channel) {
    return false;
  }
  if (criteria.owner && account.metadata.owner !== criteria.owner) {
    return false;
  }
  if (criteria.tags && criteria.tags.length > 0) {
    const hasAllTags = criteria.tags.every((tag) =>
      account.metadata.tags.includes(tag),
    );
    if (!hasAllTags) return false;
  }
  return true;
}
