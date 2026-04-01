// Client classes
export { MessagingGatewayClient, GatewayApiError } from './client.js';
export { MessagingGatewayEvents } from './events.js';

// All types
export type {
  // Config
  ClientConfig,
  EventsConfig,

  // Channels & Providers
  ChannelType,
  ProviderType,
  AccountStatus,

  // Content model
  MessageContent,
  TextContent,
  ImageContent,
  AudioContent,
  VideoContent,
  DocumentContent,
  StickerContent,
  LocationContent,
  ContactContent,
  ReactionContent,
  PollContent,
  InteractiveResponseContent,
  SystemContent,
  UnknownContent,
  MediaInfo,

  // Envelope
  UnifiedEnvelope,
  GatewayMetadata,
  MessageContext,
  ChannelDetails,
  ContactRef,

  // Send
  SendMessageCommand,
  SendContent,
  RoutingCriteria,
  MessageResult,

  // Accounts
  Account,
  AccountMetadata,
  CreateAccountInput,
  UpdateAccountInput,

  // Webhooks
  WebhookConfig,
  WebhookConfigInput,
  WebhookEventType,

  // Health
  HealthStatus,

  // Errors
  GatewayError,

  // WebSocket
  WsEventType,
  WsEvent,
  ConnectionUpdateData,
  MessageSentData,
  MessageSendFailedData,
} from './types.js';
