import type { ChannelType } from '../../domain/messaging/channel.types.js';
import type { ChannelAccount } from '../../domain/accounts/channel-account.js';
import type { ChannelAccountRepository } from '../../domain/accounts/channel-account.repository.js';
import { matchesRoutingCriteria } from '../../domain/routing/routing-rules.js';

export class InMemoryAccountRepository implements ChannelAccountRepository {
  private accounts: ChannelAccount[];

  constructor(accounts: ChannelAccount[]) {
    this.accounts = accounts;
  }

  async findById(id: string): Promise<ChannelAccount | undefined> {
    return this.accounts.find((a) => a.id === id);
  }

  async findAll(): Promise<ChannelAccount[]> {
    return [...this.accounts];
  }

  async findByChannel(channel: ChannelType): Promise<ChannelAccount[]> {
    return this.accounts.filter((a) => a.channel === channel);
  }

  async findByOwner(owner: string): Promise<ChannelAccount[]> {
    return this.accounts.filter((a) => a.metadata.owner === owner);
  }

  async findByTags(tags: string[]): Promise<ChannelAccount[]> {
    return this.accounts.filter((a) =>
      tags.every((tag) => a.metadata.tags.includes(tag)),
    );
  }

  async findByRoutingRules(criteria: {
    channel?: string;
    owner?: string;
    tags?: string[];
  }): Promise<ChannelAccount | undefined> {
    return this.accounts.find(
      (a) => a.status === 'active' && matchesRoutingCriteria(a, criteria),
    );
  }
}
