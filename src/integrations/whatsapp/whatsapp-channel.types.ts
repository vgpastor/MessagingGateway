import type { UnifiedEnvelope } from '../../core/messaging/unified-envelope.js';

// === WhatsApp Inbound Event (complete native contract) ===

export interface WhatsAppInboundEvent {
  messageId: string;
  from: WhatsAppContact;
  chat: WhatsAppChat;
  message: WhatsAppMessage;
  context?: WhatsAppMessageContext;
  raw: unknown;
}

export interface WhatsAppContact {
  wid: string;
  pushName?: string;
  profilePicUrl?: string;
  isBusinessAccount: boolean;
  isBroadcast: boolean;
}

export interface WhatsAppChat {
  chatId: string;
  isGroup: boolean;
  groupMetadata?: WhatsAppGroupMetadata;
}

export interface WhatsAppGroupMetadata {
  name: string;
  description?: string;
  participants: WhatsAppGroupParticipant[];
  admins: string[];
  createdAt: Date;
  isAnnouncement: boolean;
}

export interface WhatsAppGroupParticipant {
  wid: string;
  isAdmin: boolean;
  isSuperAdmin: boolean;
}

export interface WhatsAppMessageContext {
  isForwarded: boolean;
  forwardingScore?: number;
  isFrequentlyForwarded: boolean;
  quotedMessage?: {
    messageId: string;
    body?: string;
    participant?: string;
  };
  mentionedIds?: string[];
  isEphemeral: boolean;
  ephemeralDuration?: number;
  isFromStatusBroadcast: boolean;
  isViewOnce: boolean;
}

// === Message Types (discriminated union) ===

export type WhatsAppMessage =
  | WhatsAppTextMessage
  | WhatsAppImageMessage
  | WhatsAppAudioMessage
  | WhatsAppVideoMessage
  | WhatsAppDocumentMessage
  | WhatsAppStickerMessage
  | WhatsAppLocationMessage
  | WhatsAppContactMessage
  | WhatsAppReactionMessage
  | WhatsAppPollMessage
  | WhatsAppListResponseMessage
  | WhatsAppButtonResponseMessage
  | WhatsAppSystemMessage
  | WhatsAppCallEvent;

export interface WhatsAppTextMessage {
  type: 'text';
  body: string;
}

export interface WhatsAppImageMessage {
  type: 'image';
  mediaId: string;
  mimeType: string;
  caption?: string;
  mediaUrl?: string;
  fileSize?: number;
}

export interface WhatsAppAudioMessage {
  type: 'audio';
  mediaId: string;
  mimeType: string;
  isVoiceNote: boolean;
  duration?: number;
  mediaUrl?: string;
  fileSize?: number;
}

export interface WhatsAppVideoMessage {
  type: 'video';
  mediaId: string;
  mimeType: string;
  caption?: string;
  duration?: number;
  mediaUrl?: string;
  fileSize?: number;
}

export interface WhatsAppDocumentMessage {
  type: 'document';
  mediaId: string;
  mimeType: string;
  fileName: string;
  caption?: string;
  mediaUrl?: string;
  fileSize?: number;
}

export interface WhatsAppStickerMessage {
  type: 'sticker';
  mediaId: string;
  mimeType: string;
  isAnimated: boolean;
  mediaUrl?: string;
}

export interface WhatsAppLocationMessage {
  type: 'location';
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
  url?: string;
}

export interface WhatsAppContactMessage {
  type: 'contact';
  contacts: Array<{
    name: { formatted: string; first?: string; last?: string };
    phones: Array<{ phone: string; type?: string }>;
    emails?: Array<{ email: string; type?: string }>;
  }>;
}

export interface WhatsAppReactionMessage {
  type: 'reaction';
  emoji: string;
  targetMessageId: string;
}

export interface WhatsAppPollMessage {
  type: 'poll';
  pollName: string;
  options: string[];
  selectedOptions?: string[];
  allowMultipleAnswers: boolean;
}

export interface WhatsAppListResponseMessage {
  type: 'list_response';
  title: string;
  selectedRowId: string;
  description?: string;
}

export interface WhatsAppButtonResponseMessage {
  type: 'button_response';
  selectedButtonId: string;
  selectedButtonText: string;
}

export type WhatsAppSystemEventType =
  | 'group_created'
  | 'participant_added'
  | 'participant_removed'
  | 'participant_promoted'
  | 'participant_demoted'
  | 'group_name_changed'
  | 'group_description_changed'
  | 'group_icon_changed'
  | 'ephemeral_changed'
  | 'unknown';

export interface WhatsAppSystemMessage {
  type: 'system';
  eventType: WhatsAppSystemEventType;
  body?: string;
  affectedParticipants?: string[];
}

export interface WhatsAppCallEvent {
  type: 'call';
  callId: string;
  isVideo: boolean;
  status: 'ringing' | 'missed' | 'rejected' | 'ended';
  duration?: number;
}

// === Status Events ===

export interface WhatsAppStatusEvent {
  messageId: string;
  status: 'sent' | 'delivered' | 'read' | 'played' | 'failed';
  timestamp: Date;
  recipient: string;
  failureReason?: string;
  pricing?: {
    category: 'business_initiated' | 'user_initiated' | 'referral_free';
    model: string;
  };
}

// === Typed Envelope ===

export type WhatsAppEnvelope = UnifiedEnvelope;
