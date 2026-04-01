import { randomUUID as uuid } from 'node:crypto';
import type { MessageContent, MessageContext, ChannelDetails } from '../../core/messaging/content.js';
import type { UnifiedEnvelope } from '../../core/messaging/unified-envelope.js';
import type { ChannelAccount } from '../../core/accounts/channel-account.js';
import type { WhatsAppInboundEvent, WhatsAppMessage, WhatsAppMessageContext } from './whatsapp-channel.types.js';

/** Convert WhatsApp message to standardized MessageContent */
export function mapWhatsAppMessageToContent(msg: WhatsAppMessage): MessageContent {
  switch (msg.type) {
    case 'text':
      return { type: 'text', body: msg.body };

    case 'image':
      return {
        type: 'image',
        media: { id: msg.mediaId, mimeType: msg.mimeType, size: msg.fileSize, url: msg.mediaUrl },
        caption: msg.caption,
      };

    case 'audio':
      return {
        type: 'audio',
        media: { id: msg.mediaId, mimeType: msg.mimeType, size: msg.fileSize, url: msg.mediaUrl },
        isVoiceNote: msg.isVoiceNote,
        duration: msg.duration,
      };

    case 'video':
      return {
        type: 'video',
        media: { id: msg.mediaId, mimeType: msg.mimeType, size: msg.fileSize, url: msg.mediaUrl },
        caption: msg.caption,
        duration: msg.duration,
      };

    case 'document':
      return {
        type: 'document',
        media: { id: msg.mediaId, mimeType: msg.mimeType, size: msg.fileSize, url: msg.mediaUrl },
        fileName: msg.fileName,
        caption: msg.caption,
      };

    case 'sticker':
      return {
        type: 'sticker',
        media: { id: msg.mediaId, mimeType: msg.mimeType, url: msg.mediaUrl },
        isAnimated: msg.isAnimated,
      };

    case 'location':
      return {
        type: 'location',
        latitude: msg.latitude,
        longitude: msg.longitude,
        name: msg.name,
        address: msg.address,
        url: msg.url,
      };

    case 'contact':
      return {
        type: 'contact',
        contacts: msg.contacts.map((c) => ({
          name: c.name.formatted,
          phones: c.phones.map((p) => ({ number: p.phone, label: p.type })),
          emails: c.emails?.map((e) => ({ address: e.email, label: e.type })),
        })),
      };

    case 'reaction':
      return {
        type: 'reaction',
        emoji: msg.emoji,
        targetMessageId: msg.targetMessageId,
      };

    case 'poll':
      return {
        type: 'poll',
        question: msg.pollName,
        options: msg.options,
        selectedOptions: msg.selectedOptions,
        allowMultipleAnswers: msg.allowMultipleAnswers,
      };

    case 'list_response':
      return {
        type: 'interactive_response',
        responseType: 'list',
        selectedId: msg.selectedRowId,
        selectedText: msg.title,
        description: msg.description,
      };

    case 'button_response':
      return {
        type: 'interactive_response',
        responseType: 'button',
        selectedId: msg.selectedButtonId,
        selectedText: msg.selectedButtonText,
      };

    case 'system':
      return {
        type: 'system',
        eventType: msg.eventType,
        body: msg.body,
        affectedUsers: msg.affectedParticipants,
      };

    case 'call':
      return {
        type: 'unknown',
        body: `Call: ${msg.isVideo ? 'video' : 'voice'} (${msg.status})`,
      };

    default:
      return { type: 'unknown' };
  }
}

/** Convert WhatsApp context to standardized MessageContext */
export function mapWhatsAppContext(ctx?: WhatsAppMessageContext): MessageContext | undefined {
  if (!ctx) return undefined;
  return {
    quotedMessageId: ctx.quotedMessage?.messageId,
    quotedPreview: ctx.quotedMessage?.body,
    isForwarded: ctx.isForwarded || undefined,
    isFrequentlyForwarded: ctx.isFrequentlyForwarded || undefined,
    mentions: ctx.mentionedIds?.length ? ctx.mentionedIds : undefined,
    isEphemeral: ctx.isEphemeral || undefined,
    isViewOnce: ctx.isViewOnce || undefined,
  };
}

/** Build WhatsApp-specific channel details */
export function mapWhatsAppChannelDetails(event: WhatsAppInboundEvent): ChannelDetails {
  return {
    platform: 'whatsapp',
    messageId: event.messageId,
    isGroup: event.chat.isGroup,
    groupName: event.chat.groupMetadata?.name,
    isBusinessAccount: event.from.isBusinessAccount,
    isBroadcast: event.from.isBroadcast,
    profilePicUrl: event.from.profilePicUrl,
  };
}

/** Build a fully standardized UnifiedEnvelope from a WhatsApp event */
export function buildWhatsAppEnvelope(
  event: WhatsAppInboundEvent,
  account: ChannelAccount,
): UnifiedEnvelope {
  return {
    id: `msg_${uuid()}`,
    accountId: account.id,
    channel: 'whatsapp',
    direction: 'inbound',
    timestamp: new Date(),
    conversationId: event.chat.chatId,
    sender: {
      id: event.from.wid,
      displayName: event.from.pushName,
    },
    recipient: {
      id: account.identity.channel === 'whatsapp' ? account.identity.phoneNumber : account.id,
    },
    content: mapWhatsAppMessageToContent(event.message),
    context: mapWhatsAppContext(event.context),
    channelDetails: mapWhatsAppChannelDetails(event),
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
