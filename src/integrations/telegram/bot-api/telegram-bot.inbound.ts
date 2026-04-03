import type { InboundWebhookPort, RawRequest } from '../../../core/messaging/inbound-webhook.port.js';
import type { ChannelAccount } from '../../../core/accounts/channel-account.js';
import type { UnifiedEnvelope } from '../../../core/messaging/unified-envelope.js';
import type { TelegramMessage } from '../telegram-channel.types.js';
import { buildTelegramEnvelope } from '../telegram-content.mapper.js';
import { InvalidPayloadError } from '../../../core/errors.js';

/**
 * Raw Telegram Bot API Update object (snake_case as received from Telegram).
 * We convert to our camelCase TelegramMessage in parseIncoming.
 */
export interface TelegramRawUpdate {
  update_id: number;
  message?: TelegramRawMessage;
  edited_message?: TelegramRawMessage;
  channel_post?: TelegramRawMessage;
  edited_channel_post?: TelegramRawMessage;
}

interface TelegramRawMessage {
  message_id: number;
  from?: {
    id: number;
    is_bot: boolean;
    first_name: string;
    last_name?: string;
    username?: string;
    language_code?: string;
  };
  chat: {
    id: number;
    type: 'private' | 'group' | 'supergroup' | 'channel';
    title?: string;
    username?: string;
    first_name?: string;
    last_name?: string;
  };
  date: number;
  text?: string;
  photo?: Array<{
    file_id: string;
    file_unique_id: string;
    width: number;
    height: number;
    file_size?: number;
  }>;
  audio?: {
    file_id: string;
    file_unique_id: string;
    duration: number;
    performer?: string;
    title?: string;
    mime_type?: string;
    file_size?: number;
  };
  video?: {
    file_id: string;
    file_unique_id: string;
    width: number;
    height: number;
    duration: number;
    mime_type?: string;
    file_size?: number;
  };
  document?: {
    file_id: string;
    file_unique_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
  voice?: {
    file_id: string;
    file_unique_id: string;
    duration: number;
    mime_type?: string;
    file_size?: number;
  };
  sticker?: {
    file_id: string;
    file_unique_id: string;
    width: number;
    height: number;
    is_animated: boolean;
    is_video: boolean;
    emoji?: string;
  };
  location?: {
    latitude: number;
    longitude: number;
  };
  contact?: {
    phone_number: string;
    first_name: string;
    last_name?: string;
    user_id?: number;
  };
  caption?: string;
  reply_to_message?: TelegramRawMessage;
}

/** Convert snake_case raw Telegram message to our camelCase TelegramMessage type */
function mapRawToTelegramMessage(raw: TelegramRawMessage): TelegramMessage {
  return {
    messageId: raw.message_id,
    from: raw.from
      ? {
          id: raw.from.id,
          isBot: raw.from.is_bot,
          firstName: raw.from.first_name,
          lastName: raw.from.last_name,
          username: raw.from.username,
          languageCode: raw.from.language_code,
        }
      : undefined,
    chat: {
      id: raw.chat.id,
      type: raw.chat.type,
      title: raw.chat.title,
      username: raw.chat.username,
      firstName: raw.chat.first_name,
      lastName: raw.chat.last_name,
    },
    date: raw.date,
    text: raw.text,
    photo: raw.photo?.map((p) => ({
      fileId: p.file_id,
      fileUniqueId: p.file_unique_id,
      width: p.width,
      height: p.height,
      fileSize: p.file_size,
    })),
    audio: raw.audio
      ? {
          fileId: raw.audio.file_id,
          fileUniqueId: raw.audio.file_unique_id,
          duration: raw.audio.duration,
          performer: raw.audio.performer,
          title: raw.audio.title,
          mimeType: raw.audio.mime_type,
          fileSize: raw.audio.file_size,
        }
      : undefined,
    video: raw.video
      ? {
          fileId: raw.video.file_id,
          fileUniqueId: raw.video.file_unique_id,
          width: raw.video.width,
          height: raw.video.height,
          duration: raw.video.duration,
          mimeType: raw.video.mime_type,
          fileSize: raw.video.file_size,
        }
      : undefined,
    document: raw.document
      ? {
          fileId: raw.document.file_id,
          fileUniqueId: raw.document.file_unique_id,
          fileName: raw.document.file_name,
          mimeType: raw.document.mime_type,
          fileSize: raw.document.file_size,
        }
      : undefined,
    voice: raw.voice
      ? {
          fileId: raw.voice.file_id,
          fileUniqueId: raw.voice.file_unique_id,
          duration: raw.voice.duration,
          mimeType: raw.voice.mime_type,
          fileSize: raw.voice.file_size,
        }
      : undefined,
    sticker: raw.sticker
      ? {
          fileId: raw.sticker.file_id,
          fileUniqueId: raw.sticker.file_unique_id,
          width: raw.sticker.width,
          height: raw.sticker.height,
          isAnimated: raw.sticker.is_animated,
          isVideo: raw.sticker.is_video,
          emoji: raw.sticker.emoji,
        }
      : undefined,
    location: raw.location,
    contact: raw.contact
      ? {
          phoneNumber: raw.contact.phone_number,
          firstName: raw.contact.first_name,
          lastName: raw.contact.last_name,
          userId: raw.contact.user_id,
        }
      : undefined,
    caption: raw.caption,
    replyToMessage: raw.reply_to_message
      ? mapRawToTelegramMessage(raw.reply_to_message)
      : undefined,
  };
}

export class TelegramBotInboundAdapter
  implements InboundWebhookPort<TelegramRawUpdate, TelegramMessage>
{
  parseIncoming(raw: TelegramRawUpdate): TelegramMessage {
    // Accept message, edited_message, channel_post, or edited_channel_post
    const rawMsg =
      raw.message ?? raw.edited_message ?? raw.channel_post ?? raw.edited_channel_post;

    if (!rawMsg) {
      throw new InvalidPayloadError(
        'Telegram update contains no message, edited_message, channel_post, or edited_channel_post',
      );
    }

    return mapRawToTelegramMessage(rawMsg);
  }

  validateSignature(_req: RawRequest): boolean {
    // Telegram Bot API webhooks don't have a built-in signature mechanism.
    // The secret_token header check could be added here if configured.
    return true;
  }

  toEnvelope(event: TelegramMessage, account: ChannelAccount): UnifiedEnvelope {
    return buildTelegramEnvelope(event, account);
  }
}
