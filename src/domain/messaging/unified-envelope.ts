import type { ChannelType, ContactRef, ContentType } from './channel.types.js';

export interface ContentSummary {
  type: ContentType;
  preview?: string;
  hasMedia: boolean;
}

export interface GatewayMetadata {
  receivedAt: Date;
  adapterId: string;
  rawPayloadRef?: string;
  account: {
    id: string;
    alias: string;
    owner: string;
    tags: string[];
  };
}

export interface UnifiedEnvelope<TPayload = unknown> {
  id: string;
  accountId: string;
  channel: ChannelType;
  direction: 'inbound' | 'outbound';
  timestamp: Date;
  conversationId: string;
  sender: ContactRef;
  recipient: ContactRef;
  contentSummary: ContentSummary;
  channelPayload: TPayload;
  gateway: GatewayMetadata;
}
