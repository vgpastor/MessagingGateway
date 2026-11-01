/**
 * Shared utilities for message store implementations.
 * Extracted to avoid duplication between SQLite and PostgreSQL stores.
 */
import type { UnifiedEnvelope } from '../messaging/unified-envelope.js';
import type { ContactRef } from '../messaging/channel.types.js';

// ── UTC helpers ─────────────────────────────────────────────────

/** Convert any date-like value to ISO 8601 UTC string */
export function toUTC(value: string | Date | number): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString(); // Always ends with Z (UTC)
}

/** Current time as ISO 8601 UTC string */
export function nowUTC(): string {
  return new Date().toISOString();
}

// ── Content formatting ──────────────────────────────────────────

/** Format envelope content for AI-readable context */
export function formatContentForAI(env: UnifiedEnvelope, includeMedia: boolean): string {
  const c = env.content;
  switch (c.type) {
    case 'text': return c.body;
    case 'image': return includeMedia ? `[Image${c.caption ? `: ${c.caption}` : ''}]` : (c.caption ?? '[Image]');
    case 'video': return includeMedia ? `[Video${c.caption ? `: ${c.caption}` : ''}]` : (c.caption ?? '[Video]');
    case 'audio': return c.isVoiceNote ? '[Voice note]' : '[Audio]';
    case 'document': return `[Document: ${c.fileName}${c.caption ? ` — ${c.caption}` : ''}]`;
    case 'sticker': return '[Sticker]';
    case 'location': return `[Location: ${c.latitude}, ${c.longitude}${c.name ? ` — ${c.name}` : ''}]`;
    case 'contact': return `[Contact: ${c.contacts.map((ct) => ct.name).join(', ')}]`;
    case 'reaction': return `[Reacted with ${c.emoji}]`;
    case 'poll': return `[Poll: ${c.question}]`;
    case 'interactive_response': return `[Selected: ${c.selectedText}]`;
    case 'system': return `[System: ${c.body ?? c.eventType}]`;
    default: return '[Unknown message type]';
  }
}

/** Extract a short preview from envelope content for indexing */
export function extractPreview(envelope: UnifiedEnvelope): string | null {
  const c = envelope.content;
  switch (c.type) {
    case 'text': return c.body.substring(0, 200);
    case 'image': return c.caption?.substring(0, 200) ?? '[Image]';
    case 'video': return c.caption?.substring(0, 200) ?? '[Video]';
    case 'audio': return c.isVoiceNote ? '[Voice Note]' : '[Audio]';
    case 'document': return c.fileName;
    case 'location': return `[Location: ${c.latitude},${c.longitude}]`;
    case 'contact': return c.contacts.map((ct) => ct.name).join(', ');
    case 'reaction': return c.emoji;
    case 'poll': return c.question;
    case 'sticker': return '[Sticker]';
    default: return null;
  }
}

// ── Message log helpers ─────────────────────────────────────────

/** Hard cap for one page of `queryAfter` */
export const MAX_QUERY_AFTER_LIMIT = 500;

/** Clamp a requested page size to [1, MAX_QUERY_AFTER_LIMIT] */
export function clampPageLimit(limit: number): number {
  if (!Number.isFinite(limit)) return MAX_QUERY_AFTER_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_QUERY_AFTER_LIMIT);
}

/** WhatsApp message id carried by the envelope, or null when absent/empty (null never dedupes) */
export function waMessageIdOf(envelope: UnifiedEnvelope): string | null {
  const id = envelope.channelDetails?.messageId;
  return typeof id === 'string' && id !== '' ? id : null;
}

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

/** Cutoff instant (ISO UTC) for "older than N days" retention */
export function cutoffUTC(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

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
export function readLogFields(row: Record<string, unknown>): { seq?: number; accountSeq?: number; sentAt?: Date } {
  const out: { seq?: number; accountSeq?: number; sentAt?: Date } = {};
  if (row.seq != null) out.seq = Number(row.seq);
  if (row.account_seq != null) out.accountSeq = Number(row.account_seq);
  if (row.sent_at != null) out.sentAt = row.sent_at instanceof Date ? row.sent_at : new Date(row.sent_at as string);
  return out;
}

// ── Row mapping ─────────────────────────────────────────────────

/** Sender of a row; `phone`/`lid` are omitted when NULL (legacy rows, or channels that don't expose them) */
export function readSender(row: Record<string, unknown>): ContactRef {
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
