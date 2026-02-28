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
}
