import { randomUUID as uuid } from 'node:crypto';
import type { MessageContent, MessageContext, ChannelDetails } from '../../core/messaging/content.js';
import type { UnifiedEnvelope } from '../../core/messaging/unified-envelope.js';
import type { ChannelAccount } from '../../core/accounts/channel-account.js';
import type {
  TelegramMessage,
  TelegramPhotoSize,
} from './telegram-channel.types.js';

/** Pick the largest photo from a Telegram photo array (last element = highest resolution) */
function largestPhoto(photos: TelegramPhotoSize[]): TelegramPhotoSize | undefined {
  return photos[photos.length - 1];
}

/** Convert a Telegram message to standardized MessageContent */
export function mapTelegramMessageToContent(msg: TelegramMessage): MessageContent {
  // Text message
  if (msg.text !== undefined) {
    return { type: 'text', body: msg.text };
  }

  // Photo (array of sizes — pick largest)
  if (msg.photo && msg.photo.length > 0) {
    const photo = largestPhoto(msg.photo);
    return {
      type: 'image',
      media: {
        id: photo?.fileId,
        mimeType: 'image/jpeg',
        size: photo?.fileSize,
      },
      caption: msg.caption,
    };
  }

  // Audio
  if (msg.audio) {
    return {
      type: 'audio',
      media: {
        id: msg.audio.fileId,
        mimeType: msg.audio.mimeType ?? 'audio/mpeg',
        size: msg.audio.fileSize,
      },
      isVoiceNote: false,
      duration: msg.audio.duration,
    };
  }

  // Voice
  if (msg.voice) {
    return {
      type: 'audio',
      media: {
        id: msg.voice.fileId,
        mimeType: msg.voice.mimeType ?? 'audio/ogg',
        size: msg.voice.fileSize,
      },
      isVoiceNote: true,
      duration: msg.voice.duration,
    };
  }

  // Video
  if (msg.video) {
    return {
      type: 'video',
      media: {
        id: msg.video.fileId,
        mimeType: msg.video.mimeType ?? 'video/mp4',
        size: msg.video.fileSize,
      },
      caption: msg.caption,
      duration: msg.video.duration,
    };
  }

  // Document
  if (msg.document) {
    return {
      type: 'document',
      media: {
        id: msg.document.fileId,
        mimeType: msg.document.mimeType ?? 'application/octet-stream',
        size: msg.document.fileSize,
      },
      fileName: msg.document.fileName ?? 'document',
      caption: msg.caption,
    };
  }

  // Sticker
  if (msg.sticker) {
    return {
      type: 'sticker',
      media: {
        id: msg.sticker.fileId,
        mimeType: msg.sticker.isAnimated ? 'application/x-tgsticker' : 'image/webp',
      },
      isAnimated: msg.sticker.isAnimated || msg.sticker.isVideo,
    };
  }

  // Location
  if (msg.location) {
    return {
      type: 'location',
      latitude: msg.location.latitude,
      longitude: msg.location.longitude,
    };
  }

  // Contact
  if (msg.contact) {
    return {
      type: 'contact',
      contacts: [
        {
          name: [msg.contact.firstName, msg.contact.lastName].filter(Boolean).join(' '),
          phones: [{ number: msg.contact.phoneNumber }],
        },
      ],
    };
  }

  return { type: 'unknown' };
}

/** Build Telegram-specific channel details */
export function mapTelegramChannelDetails(
  msg: TelegramMessage,
): ChannelDetails {
  return {
    platform: 'telegram',
    chatType: msg.chat.type,
    messageId: msg.messageId,
    chatTitle: msg.chat.title,
  };
}

/** Convert reply context to standardized MessageContext */
export function mapTelegramContext(msg: TelegramMessage): MessageContext | undefined {
  if (!msg.replyToMessage) return undefined;
  return {
    quotedMessageId: String(msg.replyToMessage.messageId),
    quotedPreview: msg.replyToMessage.text,
  };
}

/** Build a fully standardized UnifiedEnvelope from a Telegram message + account */
export function buildTelegramEnvelope(
  msg: TelegramMessage,
  account: ChannelAccount,
): UnifiedEnvelope {
  return {
    id: `msg_${uuid()}`,
    accountId: account.id,
    channel: 'telegram',
    direction: 'inbound',
    timestamp: new Date(msg.date * 1000),
    conversationId: String(msg.chat.id),
    sender: {
      id: String(msg.from?.id ?? msg.chat.id),
      displayName: msg.from?.firstName,
    },
    recipient: {
      id: account.id,
    },
    content: mapTelegramMessageToContent(msg),
    context: mapTelegramContext(msg),
    channelDetails: mapTelegramChannelDetails(msg),
    gateway: {
      receivedAt: new Date(),
      adapterId: account.provider,
      account: {
        id: account.id,
        alias: account.alias,
        owner: account.metadata.owner,
        tags: account.metadata.tags,
      },
    },
  };
}
