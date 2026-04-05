// ── Auto-generated REST client and types (from OpenAPI via Orval) ──
export * from './generated/api.js';

// ── Configuration (must call before using generated client) ──
export { configure } from './fetch-mutator.js';

// ── WebSocket client (manual — not covered by OpenAPI) ──
export { MessagingGatewayEvents } from './events.js';

// ── Legacy REST client (prefer generated functions above) ──
export { MessagingGatewayClient, GatewayApiError } from './client.js';

// ── Manual types (WebSocket events + filters, not in OpenAPI) ──
export type {
  ClientConfig,
  EventsConfig,
  WsEventType,
  WsEvent,
  ConnectionUpdateData,
  MessageSentData,
  MessageSendFailedData,
  EnvelopeFilter,
  FilterValue,
} from './types.js';

// ── Core messaging types ──
export type {
  UnifiedEnvelope,
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
  MessageContext,
  ChannelDetails,
  ContactRef,
  GatewayMetadata,
  SendMessageCommand,
  SendContent,
  RoutingCriteria,
  MessageResult,
  ChannelType,
  ProviderType,
  AccountStatus,
} from './types.js';

// ── Account & webhook types ──
export type {
  Account,
  AccountMetadata,
  CreateAccountInput,
  UpdateAccountInput,
  WebhookConfig,
  WebhookConfigInput,
  WebhookEventType,
  HealthStatus,
  GatewayError,
  GroupInfo,
  GroupParticipant,
} from './types.js';

// ── Persistence & analytics types (requires STORAGE_ENABLED) ──
export type {
  MessageQuery,
  MessageQueryResult,
  MessageStats,
  ConversationContext,
  ConversationContextOptions,
  ConversationMessage,
} from './types.js';
