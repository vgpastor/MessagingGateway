/**
 * How a message maps to a row of `messages`, shared by the SQLite and PostgreSQL stores.
 * What differs by dialect stays in each store, or comes in as a parameter.
 */
import type { MessageStats, MessageQuery } from '../core/persistence/message-store.port.js';
import type { ContactRef } from '../core/messaging/channel.types.js';
import type { UnifiedEnvelope } from '../core/messaging/unified-envelope.js';
import { extractPreview, nowUTC, toUTC, waMessageIdOf } from '../core/persistence/message-store.utils.js';

// ── Writing a row ───────────────────────────────────────────────

/**
 * What a text column can hold: PostgreSQL refuses U+0000 in TEXT and JSONB, and a lone
 * surrogate in JSONB. Provider data can carry both, and one bad character must not cost the message.
 */
export function cleanText(text: string): string {
  return text.replaceAll('\u0000', '').toWellFormed();
}

/**
 * Serialize a JSON column, cleaning every string and key on the way. Done on the values:
 * in the serialized text a real NUL escape cannot be told from a literal backslash + `u0000`.
 */
export function toJsonColumn(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (typeof inner === 'string') return cleanText(inner);
    if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) return inner;
    return Object.fromEntries(Object.entries(inner).map(([key, item]) => [cleanText(key), item]));
  });
}

/** Columns written by an insert, in the order of {@link messageRowValues} */
export const MESSAGE_INSERT_COLUMNS = `id, account_id, channel, direction, conversation_id,
  sender_id, sender_name, sender_phone, sender_lid, recipient_id,
  content_type, content_preview, content_json,
  context_json, channel_details_json, gateway_json,
  timestamp, created_at, wa_message_id, sent_at, raw_json`;

/** Values of a message row, ready to store. `raw` is the provider payload, when there is one to keep. */
export function messageRowValues(envelope: UnifiedEnvelope, raw?: unknown): Array<string | null> {
  const text = (value: string | null | undefined) => (value == null ? null : cleanText(value));
  const waMessageId = waMessageIdOf(envelope);
  return [
    text(envelope.id),
    text(envelope.accountId),
    text(envelope.channel),
    text(envelope.direction),
    text(envelope.conversationId),
    text(envelope.sender.id),
    text(envelope.sender.displayName),
    text(envelope.sender.phone),
    text(envelope.sender.lid),
    text(envelope.recipient.id),
    text(envelope.content.type),
    text(extractPreview(envelope)),
    toJsonColumn(envelope.content),
    envelope.context ? toJsonColumn(envelope.context) : null,
    envelope.channelDetails ? toJsonColumn(envelope.channelDetails) : null,
    toJsonColumn(envelope.gateway),
    toUTC(envelope.timestamp),
    nowUTC(),
    text(waMessageId),
    envelope.sentAt ? toUTC(envelope.sentAt) : null,
    raw === undefined ? null : toJsonColumn(raw),
  ];
}

// ── Reading a row ───────────────────────────────────────────────

/**
 * Columns that make up an envelope. Deliberately excludes `raw_json` (can be large and is
 * only needed on demand) and `search_vector`, so list/search reads don't drag them along.
 */
const ENVELOPE_COLUMN_NAMES = [
  'id', 'account_id', 'channel', 'direction', 'conversation_id',
  'sender_id', 'sender_name', 'sender_phone', 'sender_lid', 'recipient_id',
  'content_type', 'content_preview', 'content_json',
  'context_json', 'channel_details_json', 'gateway_json',
  'timestamp', 'created_at',
  'seq', 'account_seq', 'wa_message_id', 'sent_at',
] as const;

/** Reads `content_json` without the base64 historic rows carry inline: it stays in the row, never in an envelope. */
const CONTENT_WITHOUT_BASE64 = {
  postgres: (column: string) => `${column} #- '{media,base64}' AS content_json`,
  sqlite: (column: string) => `json_remove(${column}, '$.media.base64') AS content_json`,
} as const;

/** SQL column list for envelope reads, optionally qualified with a table alias */
export function envelopeColumns(dialect: keyof typeof CONTENT_WITHOUT_BASE64, alias?: string): string {
  const prefix = alias ? `${alias}.` : '';
  return ENVELOPE_COLUMN_NAMES
    .map((c) => (c === 'content_json' ? CONTENT_WITHOUT_BASE64[dialect](`${prefix}${c}`) : `${prefix}${c}`))
    .join(', ');
}

/** Message-log fields of a row (BIGINT arrives as string from `pg`; absent for legacy rows) */
function readLogFields(row: Record<string, unknown>): { seq?: number; accountSeq?: number; sentAt?: Date } {
  const out: { seq?: number; accountSeq?: number; sentAt?: Date } = {};
  if (row.seq != null) out.seq = Number(row.seq);
  if (row.account_seq != null) out.accountSeq = Number(row.account_seq);
  if (row.sent_at != null) out.sentAt = row.sent_at instanceof Date ? row.sent_at : new Date(row.sent_at as string);
  return out;
}

/** Sender of a row; `phone`/`lid` are omitted when NULL (legacy rows, or channels that don't expose them) */
function readSender(row: Record<string, unknown>): ContactRef {
  const sender: ContactRef = { id: row.sender_id as string, displayName: (row.sender_name as string | null) ?? undefined };
  if (row.sender_phone != null) sender.phone = row.sender_phone as string;
  if (row.sender_lid != null) sender.lid = row.sender_lid as string;
  return sender;
}

/** Parse a JSON column that may already be an object (PostgreSQL JSONB) or a string (SQLite TEXT) */
export function parseJsonColumn<T = unknown>(value: string | Record<string, unknown> | null | undefined): T | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return JSON.parse(value) as T;
  return value as T;
}

/** Parse a required JSON column (never undefined) */
export function parseJsonColumnRequired<T = unknown>(value: string | Record<string, unknown>): T {
  if (typeof value === 'string') return JSON.parse(value) as T;
  return value as T;
}

/** The envelope of a row read with {@link envelopeColumns}. A timestamp arrives as a Date from `pg`, as text from SQLite. */
export function rowToEnvelope(row: Record<string, unknown>): UnifiedEnvelope {
  const ts = row.timestamp;
  return {
    id: row.id as string,
    accountId: row.account_id as string,
    channel: row.channel,
    direction: row.direction,
    timestamp: ts instanceof Date ? ts : new Date(ts as string),
    conversationId: row.conversation_id as string,
    sender: readSender(row),
    recipient: { id: row.recipient_id as string },
    content: parseJsonColumnRequired(row.content_json as string),
    context: parseJsonColumn(row.context_json as string | null) ?? undefined,
    channelDetails: parseJsonColumn(row.channel_details_json as string | null) ?? undefined,
    gateway: parseJsonColumnRequired(row.gateway_json as string),
    ...readLogFields(row),
  } as UnifiedEnvelope;
}

// ── Filters ─────────────────────────────────────────────────────

/** `WHERE` clause for the given filters. `placeholder` writes the n-th parameter (from 1) in the dialect's syntax. */
export function buildMessageWhere(
  filters: Partial<MessageQuery>,
  placeholder: (position: number) => string,
): { where: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const add = (condition: string, value: unknown) => {
    params.push(value);
    conditions.push(`${condition} ${placeholder(params.length)}`);
  };

  if (filters.accountId) add('account_id =', filters.accountId);
  if (filters.channel) add('channel =', filters.channel);
  if (filters.conversationId) add('conversation_id =', filters.conversationId);
  if (filters.senderId) add('sender_id =', filters.senderId);
  if (filters.contentType) add('content_type =', filters.contentType);
  if (filters.direction) add('direction =', filters.direction);
  if (filters.since) add('timestamp >=', toUTC(filters.since));
  if (filters.until) add('timestamp <=', toUTC(filters.until));

  return { where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

// ── Statistics ──────────────────────────────────────────────────

/** The two expressions of the statistics that differ by dialect. */
export interface StatsDialect {
  /** A row count that arrives as a number */
  count: string;
  /** The UTC hour of `timestamp`, as a number */
  hour: string;
}

/** Each query of {@link MessageStats}, ready to run with the params of {@link buildMessageWhere}. */
export function statsQueries(where: string, { count, hour }: StatsDialect) {
  return {
    total: `SELECT ${count} as total FROM messages ${where}`,
    channels: `SELECT channel, ${count} as cnt FROM messages ${where} GROUP BY channel`,
    types: `SELECT content_type, ${count} as cnt FROM messages ${where} GROUP BY content_type`,
    directions: `SELECT direction, ${count} as cnt FROM messages ${where} GROUP BY direction`,
    conversations: `SELECT conversation_id, ${count} as cnt, MAX(content_preview) as last_preview FROM messages ${where} GROUP BY conversation_id ORDER BY cnt DESC LIMIT 10`,
    hours: `SELECT ${hour} as hour, ${count} as cnt FROM messages ${where} GROUP BY hour`,
  };
}

/** What {@link statsQueries} returns once run */
export interface StatsRows {
  total: number;
  channels: Array<{ channel: string; cnt: number }>;
  types: Array<{ content_type: string; cnt: number }>;
  directions: Array<{ direction: string; cnt: number }>;
  conversations: Array<{ conversation_id: string; cnt: number; last_preview: string | null }>;
  hours: Array<{ hour: number; cnt: number }>;
}

export function statsFromRows({ total, channels, types, directions, conversations, hours }: StatsRows): MessageStats {
  const byHour: number[] = new Array<number>(24).fill(0);
  for (const r of hours) byHour[r.hour] = r.cnt;

  return {
    totalMessages: total,
    byChannel: Object.fromEntries(channels.map((r) => [r.channel, r.cnt])),
    byContentType: Object.fromEntries(types.map((r) => [r.content_type, r.cnt])),
    byDirection: Object.fromEntries(directions.map((r) => [r.direction, r.cnt])),
    topConversations: conversations.map((r) => ({
      conversationId: r.conversation_id,
      count: r.cnt,
      lastMessage: r.last_preview ?? undefined,
    })),
    byHour,
  };
}
