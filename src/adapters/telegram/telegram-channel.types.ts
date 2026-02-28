import type { UnifiedEnvelope } from '../../domain/messaging/unified-envelope.js';

export interface TelegramUpdate {
  updateId: number;
  message?: TelegramMessage;
  editedMessage?: TelegramMessage;
  callbackQuery?: TelegramCallbackQuery;
  raw: unknown;
}

export interface TelegramMessage {
  messageId: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  photo?: TelegramPhotoSize[];
  audio?: TelegramAudio;
  video?: TelegramVideo;
  document?: TelegramDocument;
  voice?: TelegramVoice;
  sticker?: TelegramSticker;
  location?: TelegramLocation;
  contact?: TelegramContact;
  caption?: string;
  replyToMessage?: TelegramMessage;
}

export interface TelegramUser {
  id: number;
  isBot: boolean;
  firstName: string;
  lastName?: string;
  username?: string;
  languageCode?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
}

export interface TelegramPhotoSize {
  fileId: string;
  fileUniqueId: string;
  width: number;
  height: number;
  fileSize?: number;
}

export interface TelegramAudio {
  fileId: string;
  fileUniqueId: string;
  duration: number;
  performer?: string;
  title?: string;
  mimeType?: string;
  fileSize?: number;
}

export interface TelegramVideo {
  fileId: string;
  fileUniqueId: string;
  width: number;
  height: number;
  duration: number;
  mimeType?: string;
  fileSize?: number;
}

export interface TelegramDocument {
  fileId: string;
  fileUniqueId: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
}

export interface TelegramVoice {
  fileId: string;
  fileUniqueId: string;
  duration: number;
  mimeType?: string;
  fileSize?: number;
}

export interface TelegramSticker {
  fileId: string;
  fileUniqueId: string;
  width: number;
  height: number;
  isAnimated: boolean;
  isVideo: boolean;
  emoji?: string;
}

export interface TelegramLocation {
  latitude: number;
  longitude: number;
}

export interface TelegramContact {
  phoneNumber: string;
  firstName: string;
  lastName?: string;
  userId?: number;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export type TelegramEnvelope = UnifiedEnvelope<TelegramUpdate>;
