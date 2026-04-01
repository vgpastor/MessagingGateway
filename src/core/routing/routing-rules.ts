import type { ChannelAccount } from '../accounts/channel-account.js';

export interface RoutingCriteria {
  channel?: string;
  owner?: string;
  tags?: string[];
}

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
