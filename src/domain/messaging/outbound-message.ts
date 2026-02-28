import type { ContentType } from './channel.types.js';

export interface OutboundMessageContent {
  type: ContentType;
  body?: string;
  mediaUrl?: string;
  mimeType?: string;
  fileName?: string;
  caption?: string;
  latitude?: number;
  longitude?: number;
}

export interface OutboundMessage {
  to: string;
  content: OutboundMessageContent;
  accountId: string;
  replyToMessageId?: string;
  metadata?: Record<string, unknown>;
}

export interface SendMessageCommand {
  fromAccountId?: string;
  routing?: RoutingCriteria;
  to: string;
  content: OutboundMessageContent;
  replyToMessageId?: string;
  metadata?: Record<string, unknown>;
}

export interface RoutingCriteria {
  channel?: string;
  owner?: string;
  tags?: string[];
}
