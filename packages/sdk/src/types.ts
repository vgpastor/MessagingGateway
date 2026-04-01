// ── Channels & Providers ────────────────────────────────────────

export type ChannelType = 'whatsapp' | 'telegram' | 'email' | 'sms';

export type ProviderType =
  | 'wwebjs-api' | 'evolution-api' | 'meta-cloud-api' | 'baileys'
  | 'telegram-bot-api' | 'brevo' | 'ses' | 'twilio' | 'messagebird';

export type AccountStatus = 'active' | 'suspended' | 'auth_expired' | 'error' | 'unchecked';

// ── Content Model ───────────────────────────────────────────────

export type MessageContent =
  | TextContent | ImageContent | AudioContent | VideoContent
  | DocumentContent | StickerContent | LocationContent | ContactContent
  | ReactionContent | PollContent | InteractiveResponseContent
  | SystemContent | UnknownContent;

export interface TextContent { type: 'text'; body: string }
export interface ImageContent { type: 'image'; media: MediaInfo; caption?: string }
export interface AudioContent { type: 'audio'; media: MediaInfo; isVoiceNote?: boolean; duration?: number }
export interface VideoContent { type: 'video'; media: MediaInfo; caption?: string; duration?: number }
export interface DocumentContent { type: 'document'; media: MediaInfo; fileName: string; caption?: string }
export interface StickerContent { type: 'sticker'; media: MediaInfo; isAnimated?: boolean }
export interface LocationContent { type: 'location'; latitude: number; longitude: number; name?: string; address?: string; url?: string }
export interface ContactContent {
  type: 'contact';
  contacts: Array<{
    name: string;
    phones: Array<{ number: string; label?: string }>;
    emails?: Array<{ address: string; label?: string }>;
  }>;
}
export interface ReactionContent { type: 'reaction'; emoji: string; targetMessageId: string }
export interface PollContent { type: 'poll'; question: string; options: string[]; selectedOptions?: string[]; allowMultipleAnswers?: boolean }
export interface InteractiveResponseContent { type: 'interactive_response'; responseType: 'button' | 'list' | 'other'; selectedId: string; selectedText: string; description?: string }
export interface SystemContent { type: 'system'; eventType: string; body?: string; affectedUsers?: string[] }
export interface UnknownContent { type: 'unknown'; body?: string }

export interface MediaInfo { id?: string; url?: string; mimeType: string; size?: number }

// ── Message Context ─────────────────────────────────────────────

export interface MessageContext {
  quotedMessageId?: string;
  quotedPreview?: string;
  isForwarded?: boolean;
  isFrequentlyForwarded?: boolean;
  mentions?: string[];
  isEphemeral?: boolean;
  isViewOnce?: boolean;
}

export interface ChannelDetails {
  platform: string;
  [key: string]: unknown;
}

// ── Contact ─────────────────────────────────────────────────────

export interface ContactRef {
  id: string;
  displayName?: string;
}

// ── Unified Envelope ────────────────────────────────────────────

export interface UnifiedEnvelope {
  id: string;
  accountId: string;
  channel: ChannelType;
  direction: 'inbound' | 'outbound';
  timestamp: string;
  conversationId: string;
  sender: ContactRef;
  recipient: ContactRef;
  content: MessageContent;
  context?: MessageContext;
  channelDetails?: ChannelDetails;
  gateway: GatewayMetadata;
}

export interface GatewayMetadata {
  receivedAt: string;
  adapterId: string;
  rawPayloadRef?: string;
  account: {
    id: string;
    alias: string;
    owner: string;
    tags: string[];
  };
}

// ── Send Command ────────────────────────────────────────────────

export interface SendMessageCommand {
  from?: string;
  routing?: RoutingCriteria;
  to: string;
  content: SendContent;
  replyToMessageId?: string;
  metadata?: Record<string, unknown>;
}

export interface RoutingCriteria {
  channel?: ChannelType;
  owner?: string;
  tags?: string[];
}

export interface SendContent {
  type: 'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker' | 'location' | 'contact' | 'reaction' | 'poll';
  body?: string;
  mediaUrl?: string;
  mimeType?: string;
  fileName?: string;
  caption?: string;
  latitude?: number;
  longitude?: number;
}

export interface MessageResult {
  messageId: string;
  status: 'queued' | 'sent' | 'delivered' | 'read' | 'played' | 'failed' | 'unknown';
  timestamp: string;
  providerMessageId?: string;
  error?: string;
}

// ── Account ─────────────────────────────────────────────────────

export interface Account {
  id: string;
  alias: string;
  channel: ChannelType;
  provider: ProviderType;
  status: AccountStatus;
  identity: Record<string, unknown>;
  connection?: {
    managed: boolean;
    status?: 'disconnected' | 'connecting' | 'connected';
    qr?: string;
  };
  metadata: AccountMetadata;
}

export interface AccountMetadata {
  owner: string;
  environment: string;
  webhookPath?: string;
  tags: string[];
}

export interface CreateAccountInput {
  id: string;
  alias: string;
  channel: ChannelType;
  provider: ProviderType;
  identity?: Record<string, unknown>;
  credentialsRef?: string;
  providerConfig?: Record<string, unknown>;
  metadata: { owner: string; environment: string; tags?: string[] };
}

export interface UpdateAccountInput {
  alias?: string;
  status?: AccountStatus;
  identity?: Record<string, unknown>;
  providerConfig?: Record<string, unknown>;
  metadata?: Partial<AccountMetadata>;
}

// ── Webhook Config ──────────────────────────────────────────────

export type WebhookEventType = 'message.inbound' | 'message.status' | 'message.sent' | '*';

export interface WebhookConfig {
  accountId: string;
  url: string;
  secret?: string;
  events: WebhookEventType[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookConfigInput {
  url: string;
  secret?: string;
  events?: WebhookEventType[];
  enabled?: boolean;
}

// ── Health ───────────────────────────────────────────────────────

export interface HealthStatus {
  status: 'ok' | 'degraded' | 'error';
  timestamp: string;
  version: string;
  uptime: number;
}

// ── Error ────────────────────────────────────────────────────────

export interface GatewayError {
  error: string;
  code: string;
  message: string;
}

// ── WebSocket Events ────────────────────────────────────────────

export type WsEventType =
  | 'connected' | 'disconnected'
  | 'message.inbound' | 'message.sent' | 'message.send.failed'
  | 'connection.update'
  | 'subscribed' | 'unsubscribed' | 'pong';

export interface WsEvent<T = unknown> {
  event: WsEventType;
  timestamp?: string;
  data?: T;
}

export interface ConnectionUpdateData {
  accountId: string;
  status: 'disconnected' | 'connecting' | 'connected';
  qr?: string;
}

export interface MessageSendFailedData {
  error: string;
  replyTo?: string;
}

// ── Client Config ───────────────────────────────────────────────

export interface ClientConfig {
  baseUrl: string;
  apiKey?: string;
}

export interface EventsConfig extends ClientConfig {
  accounts?: string[];
  autoReconnect?: boolean;
  reconnectIntervalMs?: number;
}
