/**
 * Shared utilities for message store implementations.
 * Extracted to avoid duplication between SQLite and PostgreSQL stores.
 */
import type { UnifiedEnvelope } from '../messaging/unified-envelope.js';

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

// ── Row mapping ─────────────────────────────────────────────────

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
