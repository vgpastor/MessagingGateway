/**
 * Standardized message content — platform-agnostic.
 * Every inbound/outbound message is normalized to this model.
 * Consumers (WS, webhooks, API) never need to know the source platform.
 */

// ── Content (discriminated union) ───────────────────────────────

export type MessageContent =
  | TextContent
  | ImageContent
  | AudioContent
  | VideoContent
  | DocumentContent
  | StickerContent
  | LocationContent
  | ContactContent
  | ReactionContent
  | PollContent
  | InteractiveResponseContent
  | SystemContent
  | UnknownContent;

export interface TextContent {
  type: 'text';
  body: string;
}

export interface ImageContent {
  type: 'image';
  media: MediaInfo;
  caption?: string;
}

export interface AudioContent {
  type: 'audio';
  media: MediaInfo;
  isVoiceNote?: boolean;
  duration?: number;
}

export interface VideoContent {
  type: 'video';
  media: MediaInfo;
  caption?: string;
  duration?: number;
}

export interface DocumentContent {
  type: 'document';
  media: MediaInfo;
  fileName: string;
  caption?: string;
}

export interface StickerContent {
  type: 'sticker';
  media: MediaInfo;
  isAnimated?: boolean;
}

export interface LocationContent {
  type: 'location';
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
  url?: string;
}

export interface ContactContent {
  type: 'contact';
  contacts: Array<{
    name: string;
    phones: Array<{ number: string; label?: string }>;
    emails?: Array<{ address: string; label?: string }>;
  }>;
}

export interface ReactionContent {
  type: 'reaction';
  emoji: string;
  targetMessageId: string;
}

export interface PollContent {
  type: 'poll';
  question: string;
  options: string[];
  selectedOptions?: string[];
  allowMultipleAnswers?: boolean;
}

export interface InteractiveResponseContent {
  type: 'interactive_response';
  responseType: 'button' | 'list' | 'other';
  selectedId: string;
  selectedText: string;
  description?: string;
}

export interface SystemContent {
  type: 'system';
  eventType: string;
  body?: string;
  affectedUsers?: string[];
}

export interface UnknownContent {
  type: 'unknown';
  body?: string;
}

// ── Media ───────────────────────────────────────────────────────

export interface MediaInfo {
  /** Provider media reference ID (for download) */
  id?: string;
  /** Direct URL if available */
  url?: string;
  mimeType: string;
  size?: number;
  /** Base64-encoded media content (downloaded at inbound time) */
  base64?: string;
  /** Original filename if available */
  filename?: string;
}

// ── Message context ─────────────────────────────────────────────

export interface MessageContext {
  /** ID of the message being replied to */
  quotedMessageId?: string;
  /** Preview of the quoted message */
  quotedPreview?: string;
  /** Is forwarded from another chat */
  isForwarded?: boolean;
  /** Frequently forwarded (viral) */
  isFrequentlyForwarded?: boolean;
  /** Mentioned user IDs */
  mentions?: string[];
  /** Ephemeral/disappearing message */
  isEphemeral?: boolean;
  /** View-once media */
  isViewOnce?: boolean;
}

// ── Channel-specific details ────────────────────────────────────

/**
 * Optional platform-specific metadata that doesn't fit the standard model.
 * Consumers can ignore this; it's for advanced use cases.
 */
export interface ChannelDetails {
  /** Source platform identifier */
  platform: string;
  /** Platform-specific fields (type-safe per platform) */
  [key: string]: unknown;
}
