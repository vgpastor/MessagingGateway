import type { UnifiedEnvelope } from '../messaging/unified-envelope.js';
import type { MediaInfo } from '../messaging/content.js';

// ── Core CRUD port ─────────────────────────────────────────────

/**
 * Port for message persistence (CRUD + query).
 * Implementations can use SQLite, Postgres, MongoDB, etc.
 *
 * Separated from search and analytics to respect ISP — callers
 * that only need to persist messages don't depend on FTS or stats.
 */
export interface MessageStorePort {
  /** Store a message envelope. `raw` is the provider payload of a sent message, kept so it can be re-sent on request. */
  save(envelope: UnifiedEnvelope, raw?: unknown): Promise<void>;

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
export interface FullMessageStorePort
  extends MessageStorePort, MessageSearchPort, MessageAnalyticsPort, ConversationHistoryPort, MessageLogPort {}

// ── Message log port ───────────────────────────────────────────

/** Outcome of {@link MessageLogPort.insertInbound} */
export interface InsertResult {
  /** false when the message was already stored (same id, or same account + WhatsApp message id) */
  inserted: boolean;
  /** Only when not inserted: the row that already holds the message, which may be another envelope's */
  storedId?: string;
  /** Global, monotonically increasing sequence of the row */
  seq?: number;
  /** Per-account, contiguous and gap-free sequence of the row, starting at 1 */
  accountSeq?: number;
}

/** A stored envelope plus the provider payload it was built from, when kept */
export type StoredEnvelope = UnifiedEnvelope & { raw?: unknown };

/**
 * Durable, ordered log of inbound messages.
 *
 * Every inbound message gets a per-account contiguous `accountSeq` so consumers
 * can resume from the last one they saw, and is deduplicated by WhatsApp message id.
 */
export interface MessageLogPort {
  /** Rejects when the store does not answer. It involves no message, so what a message holds cannot decide it. */
  ping(): Promise<void>;

  /**
   * Atomically store an inbound message, dedupe it by (account, WhatsApp message id)
   * and assign the next `accountSeq`. A duplicate consumes no `accountSeq`.
   * Idempotent: storing the same envelope again (same id) is a duplicate too, so a
   * write whose outcome is unknown can always be retried. Rejects with a
   * `PermanentStoreError` when retrying this message cannot help.
   * `raw` is the provider payload (kept for media recovery and Baileys `getMessage`).
   */
  insertInbound(envelope: UnifiedEnvelope, raw?: unknown): Promise<InsertResult>;

  /**
   * Messages of an account with `accountSeq` greater than `afterAccountSeq`, ascending.
   * `limit` is capped at 500. `nextAfterAccountSeq` is the cursor for the next page,
   * or null when there is nothing more.
   */
  queryAfter(q: { accountId: string; afterAccountSeq: number; limit: number }): Promise<{
    messages: UnifiedEnvelope[];
    nextAfterAccountSeq: number | null;
  }>;

  /** Find a stored message by its WhatsApp message id (includes the raw payload when kept) */
  findByWaMessageId(accountId: string, waMessageId: string): Promise<StoredEnvelope | undefined>;

  /** Merge media fields (status, size, url, ...) into the message's media content */
  updateMedia(id: string, media: Partial<MediaInfo>): Promise<void>;

  /** Messages after the `afterSeq` cursor whose media is still `pending`, in `seq` order, with the raw payload needed to download it */
  findPendingMedia(limit: number, afterSeq?: number): Promise<Array<{ seq: number; id: string; accountId: string; raw: unknown }>>;

  /** Delete messages whose `created_at` is older than `days`; returns the number removed */
  deleteOlderThan(days: number): Promise<number>;

  /** Highest `accountSeq` handed out for the account (0 if none) */
  maxAccountSeq(accountId: string): Promise<number>;

  /** Lowest `accountSeq` still stored for the account (null if none): retention removed anything below it */
  minAccountSeq(accountId: string): Promise<number | null>;
}

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
