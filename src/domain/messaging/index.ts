// Re-export from core — this file exists for backwards compatibility
export type { ChannelType, ProviderType, ContentType, ContactRef } from '../../core/messaging/channel.types.js';
export type {
  UnifiedEnvelope,
  ContentSummary,
  GatewayMetadata,
} from '../../core/messaging/unified-envelope.js';
export type {
  OutboundMessage,
  OutboundMessageContent,
  SendMessageCommand,
  RoutingCriteria,
} from '../../core/messaging/outbound-message.js';
export type {
  MessageResult,
  MessageStatus,
  MessageStatusType,
  MediaContent,
} from '../../core/messaging/message-result.js';
export type { MessagingPort } from '../../core/messaging/messaging.port.js';
export type { InboundWebhookPort, RawRequest } from '../../core/messaging/inbound-webhook.port.js';
export type { ProviderHealthChecker, ValidationResult } from '../../core/messaging/provider-health.port.js';
