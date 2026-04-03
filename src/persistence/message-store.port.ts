import type { UnifiedEnvelope } from '../core/messaging/unified-envelope.js';

/**
 * Port for message persistence.
 * Implementations can use SQLite, Postgres, MongoDB, etc.
 */
export interface MessageStorePort {
  /** Store a message envelope */
  save(envelope: UnifiedEnvelope): Promise<void>;

  /** Query messages with filters */
  query(filters: MessageQuery): Promise<MessageQueryResult>;

  /** Get a single message by ID */
  findById(messageId: string): Promise<UnifiedEnvelope | undefined>;

  /** Get message count (for metrics) */
  count(filters?: Partial<MessageQuery>): Promise<number>;

  /** Full-text search across stored messages */
  search(query: string, options?: { accountId?: string; limit?: number; offset?: number }): Promise<MessageQueryResult>;

  /** Get aggregated message statistics */
  getStats(options?: { accountId?: string; since?: Date; until?: Date }): Promise<MessageStats>;

  /** Get conversation context formatted for AI consumption */
  getConversationContext(conversationId: string, options?: ConversationContextOptions): Promise<ConversationContext>;

  /** Initialize the store (create tables, etc.) */
  init(): Promise<void>;

  /** Close connections */
  close(): Promise<void>;
}

export interface MessageQuery {
  accountId?: string;
  channel?: string;
  conversationId?: string;
  senderId?: string;
  contentType?: string;
  direction?: 'inbound' | 'outbound';
  since?: Date;
  until?: Date;
  limit?: number;
  offset?: number;
}

export interface MessageQueryResult {
  messages: UnifiedEnvelope[];
  total: number;
  limit: number;
  offset: number;
}

export interface ConversationContextOptions {
  /** Max messages to include (default: 50) */
  limit?: number;
  /** Only include messages after this date */
  since?: Date;
  /** Include media descriptions (default: true) */
  includeMedia?: boolean;
  /** Account ID filter (required for multi-account setups) */
  accountId?: string;
  /** Format: 'openai' for ChatGPT-compatible, 'raw' for full envelopes */
  format?: 'openai' | 'raw';
}

export interface ConversationContext {
  conversationId: string;
  /** Group name if available */
  groupName?: string;
  /** Number of participants seen in this conversation */
  participantCount: number;
  /** Unique participants with their display names */
  participants: Array<{ id: string; name: string; messageCount: number }>;
  /** Total messages in this conversation */
  totalMessages: number;
  /** Messages formatted for AI consumption */
  messages: ConversationMessage[];
  /** Full envelopes (only when format='raw') */
  envelopes?: UnifiedEnvelope[];
}

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  name: string;
  content: string;
  timestamp: string;
  /** Original message type for context */
  type: string;
  /** Message ID for reference */
  id: string;
}

export interface MessageStats {
  totalMessages: number;
  byChannel: Record<string, number>;
  byContentType: Record<string, number>;
  byDirection: Record<string, number>;
  topConversations: Array<{ conversationId: string; count: number; lastMessage?: string }>;
  byHour: number[]; // 24 elements, messages per hour of day
}
