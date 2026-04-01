import type { ChannelType, ContactRef } from './channel.types.js';
import type { MessageContent, MessageContext, ChannelDetails } from './content.js';

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

export interface UnifiedEnvelope {
  /** Unique envelope ID (msg_<uuid>) */
  id: string;
  accountId: string;
  channel: ChannelType;
  direction: 'inbound' | 'outbound';
  timestamp: Date;
  /** Conversation/chat thread ID */
  conversationId: string;
  sender: ContactRef;
  recipient: ContactRef;

  /** Standardized message content — platform-agnostic */
  content: MessageContent;
  /** Message context (reply, forward, mentions, ephemeral) */
  context?: MessageContext;
  /** Optional channel-specific details for advanced consumers */
  channelDetails?: ChannelDetails;

  gateway: GatewayMetadata;
}