/**
 * Application service that transforms raw conversation history
 * into AI-ready formats (OpenAI, raw envelopes, etc.).
 *
 * This keeps the storage port free of AI/vendor vocabulary
 * and eliminates duplication between SQLite and PostgreSQL stores.
 */
import type { UnifiedEnvelope } from '../messaging/unified-envelope.js';
import type { ConversationHistoryPort, RawConversationHistory, ConversationHistoryOptions } from './message-store.port.js';
import { formatContentForAI } from './message-store.utils.js';

// ── Public types ───────────────────────────────────────────────

export type ContextFormat = 'openai' | 'raw';

export interface ConversationContextOptions extends ConversationHistoryOptions {
  /** Include media descriptions (default: true) */
  includeMedia?: boolean;
  /** Output format: 'openai' for ChatGPT-compatible, 'raw' for full envelopes */
  format?: ContextFormat;
}

/** AI-ready message with role mapping */
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

/** Full conversation context ready for AI consumption */
export interface ConversationContext {
  conversationId: string;
  groupName?: string;
  participantCount: number;
  participants: Array<{ id: string; name: string; messageCount: number }>;
  totalMessages: number;
  messages: ConversationMessage[];
  /** Full envelopes (only when format='raw') */
  envelopes?: UnifiedEnvelope[];
}

// ── Service ────────────────────────────────────────────────────

export class ConversationContextService {
  constructor(private readonly historyPort: ConversationHistoryPort) {}

  async getContext(
    conversationId: string,
    options?: ConversationContextOptions,
  ): Promise<ConversationContext> {
    const includeMedia = options?.includeMedia ?? true;
    const format = options?.format ?? 'openai';

    const history = await this.historyPort.getConversationHistory(conversationId, {
      limit: options?.limit,
      since: options?.since,
      accountId: options?.accountId,
    });

    const messages = this.mapToAIMessages(history.envelopes, includeMedia);

    const result: ConversationContext = {
      conversationId: history.conversationId,
      groupName: history.groupName,
      participantCount: history.participantCount,
      participants: history.participants,
      totalMessages: history.totalMessages,
      messages,
    };

    if (format === 'raw') {
      result.envelopes = history.envelopes;
    }

    return result;
  }

  /** Map domain envelopes to AI-compatible messages */
  private mapToAIMessages(envelopes: UnifiedEnvelope[], includeMedia: boolean): ConversationMessage[] {
    return envelopes.map((env) => ({
      role: mapDirectionToRole(env.direction),
      name: env.sender.displayName ?? env.sender.id,
      content: formatContentForAI(env, includeMedia),
      timestamp: env.timestamp instanceof Date ? env.timestamp.toISOString() : String(env.timestamp),
      type: env.content.type,
      id: env.id,
    }));
  }
}

// ── Pure helper ────────────────────────────────────────────────

function mapDirectionToRole(direction: 'inbound' | 'outbound'): 'user' | 'assistant' | 'system' {
  return direction === 'outbound' ? 'assistant' : 'user';
}
