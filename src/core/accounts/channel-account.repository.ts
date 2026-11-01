import type { ChannelType } from '../messaging/channel.types.js';
import type { ChannelAccount } from './channel-account.js';

export interface ChannelAccountRepository {
  findById(id: string): Promise<ChannelAccount | undefined>;
  findAll(): Promise<ChannelAccount[]>;
  findByChannel(channel: ChannelType): Promise<ChannelAccount[]>;
  findByOwner(owner: string): Promise<ChannelAccount[]>;
  findByTags(tags: string[]): Promise<ChannelAccount[]>;
  findByRoutingRules(criteria: {
    channel?: string;
    owner?: string;
    tags?: string[];
  }): Promise<ChannelAccount | undefined>;
  save(account: ChannelAccount): Promise<ChannelAccount>;
  /** A change someone asked for: it rejects and changes nothing if it cannot be made durable. */
  update(id: string, account: Partial<Omit<ChannelAccount, 'id'>>): Promise<ChannelAccount | undefined>;
  /**
   * Something the gateway saw happen to an account (its connection, a health check): it stands even if it cannot be made
   * durable, because it is true anyway. `change` runs at its turn, with the account as it is by then, and returns what to
   * set, or nothing. Resolves to the account as it ends up, undefined if it does not exist.
   */
  observe(id: string, change: (account: ChannelAccount) => Partial<Omit<ChannelAccount, 'id'>> | undefined): Promise<ChannelAccount | undefined>;
  remove(id: string): Promise<boolean>;
}
