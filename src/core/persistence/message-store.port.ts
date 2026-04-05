import type { UnifiedEnvelope } from '../messaging/unified-envelope.js';

// ── Core CRUD port ─────────────────────────────────────────────

/**
 * Port for message persistence (CRUD + query).
 * Implementations can use SQLite, Postgres, MongoDB, etc.
 *
 * Separated from search and analytics to respect ISP — callers
 * that only need to persist messages don't depend on FTS or stats.
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

  /** Initialize the store (create tables, run migrations) */
  init(): Promise<void>;

  /** Close connections */
  close(): Promise<void>;
}

// ── Search port ────────────────────────────────────────────────

/** Full-text search capability — optional, not all drivers may support it */
export interface MessageSearchPort {
  /** Full-text search across stored messages */
  search(query: string, options?: SearchOptions): Promise<MessageQueryResult>;
}

// ── Analytics port ─────────────────────────────────────────────

/** Aggregated statistics — read-only analytics */
export interface MessageAnalyticsPort {
  /** Get aggregated message statistics */
  getStats(options?: StatsOptions): Promise<MessageStats>;
}

// ── Conversation history port ──────────────────────────────────

/**
 * Raw conversation data retrieval — returns domain objects (envelopes),
 * NOT AI-formatted output. AI formatting belongs in an application service.
 */
export interface ConversationHistoryPort {
  /** Get raw conversation data: envelopes + participant info */
  getConversationHistory(conversationId: string, options?: ConversationHistoryOptions): Promise<RawConversationHistory>;
}

// ── Composite port for full-featured stores ────────────────────

/** Full-featured store that implements all capabilities */
export interface FullMessageStorePort extends MessageStorePort, MessageSearchPort, MessageAnalyticsPort, ConversationHistoryPort {}

// ── Query & result types ───────────────────────────────────────

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

export interface SearchOptions {
  accountId?: string;
  limit?: number;
  offset?: number;
}

export interface StatsOptions {
  accountId?: string;
  since?: Date;
  until?: Date;
}

// ── Raw conversation history (domain-level, no AI vocabulary) ──

export interface ConversationHistoryOptions {
  /** Max messages to include (default: 50) */
  limit?: number;
  /** Only include messages after this date */
  since?: Date;
  /** Account ID filter (required for multi-account setups) */
  accountId?: string;
}

/** Domain-level conversation data — no AI formatting, just raw envelopes */
export interface RawConversationHistory {
  conversationId: string;
  /** Group name if available */
  groupName?: string;
  /** Number of unique participants */
  participantCount: number;
  /** Unique participants with their display names */
  participants: Array<{ id: string; name: string; messageCount: number }>;
  /** Total messages in this conversation */
  totalMessages: number;
  /** Raw envelopes in chronological order */
  envelopes: UnifiedEnvelope[];
}

// ── Statistics types ───────────────────────────────────────────

export interface MessageStats {
  totalMessages: number;
  byChannel: Record<string, number>;
  byContentType: Record<string, number>;
  byDirection: Record<string, number>;
  topConversations: Array<{ conversationId: string; count: number; lastMessage?: string }>;
  byHour: number[]; // 24 elements, messages per hour of day
}
