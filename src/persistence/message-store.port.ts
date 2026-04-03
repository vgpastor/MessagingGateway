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
