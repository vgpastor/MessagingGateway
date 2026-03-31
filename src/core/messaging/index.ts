export type { ChannelType, ProviderType, ContentType, ContactRef } from './channel.types.js';
export type {
  UnifiedEnvelope,
  ContentSummary,
  GatewayMetadata,
} from './unified-envelope.js';
export type {
  OutboundMessage,
  OutboundMessageContent,
  SendMessageCommand,
  RoutingCriteria,
} from './outbound-message.js';
export type {
  MessageResult,
  MessageStatus,
  MessageStatusType,
  MediaContent,
} from './message-result.js';
export type { MessagingPort } from './messaging.port.js';
export type { InboundWebhookPort, RawRequest } from './inbound-webhook.port.js';
export type { ProviderHealthChecker, ValidationResult } from './provider-health.port.js';
