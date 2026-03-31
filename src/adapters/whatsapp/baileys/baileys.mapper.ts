import {
  extractMessageContent,
  getContentType,
  jidNormalizedUser,
} from '@whiskeysockets/baileys';
import type { proto } from '@whiskeysockets/baileys';
import type {
  WhatsAppInboundEvent,
  WhatsAppContact,
  WhatsAppChat,
  WhatsAppMessage,
  WhatsAppMessageContext,
} from '../whatsapp-channel.types.js';

type WAMessage = proto.IWebMessageInfo;

export function mapBaileysToWhatsAppEvent(message: WAMessage): WhatsAppInboundEvent {
  return {
    messageId: message.key?.id ?? '',
    from: mapContact(message),
    chat: mapChat(message),
    message: mapMessage(message),
    context: mapContext(message),
    raw: message,
  };
}

function mapContact(msg: WAMessage): WhatsAppContact {
  const remoteJid = msg.key?.remoteJid ?? '';
  const fromJid = msg.key?.fromMe
    ? jidNormalizedUser(remoteJid)
    : msg.key?.participant
      ? jidNormalizedUser(msg.key.participant)
      : jidNormalizedUser(remoteJid);

  return {
    wid: fromJid,
    pushName: msg.pushName ?? undefined,
    isBusinessAccount: false,
    isBroadcast: remoteJid === 'status@broadcast',
  };
}

function mapChat(msg: WAMessage): WhatsAppChat {
  const remoteJid = msg.key?.remoteJid ?? '';
  const isGroup = remoteJid.endsWith('@g.us');

  return {
    chatId: remoteJid,
    isGroup,
  };
}

function mapMessage(msg: WAMessage): WhatsAppMessage {
  const content = extractMessageContent(msg.message);
  if (!content) {
    return { type: 'text', body: '' };
  }

  const contentType = getContentType(content);

  switch (contentType) {
    case 'conversation':
      return { type: 'text', body: content.conversation ?? '' };

    case 'extendedTextMessage':
      return { type: 'text', body: content.extendedTextMessage?.text ?? '' };

    case 'imageMessage': {
      const img = content.imageMessage;
      return {
        type: 'image',
        mediaId: msg.key?.id ?? '',
        mimeType: img?.mimetype ?? 'image/jpeg',
        caption: img?.caption ?? undefined,
        fileSize: img?.fileLength ? Number(img.fileLength) : undefined,
      };
    }

    case 'audioMessage': {
      const audio = content.audioMessage;
      return {
        type: 'audio',
        mediaId: msg.key?.id ?? '',
        mimeType: audio?.mimetype ?? 'audio/ogg',
        isVoiceNote: audio?.ptt ?? false,
        duration: audio?.seconds ?? undefined,
        fileSize: audio?.fileLength ? Number(audio.fileLength) : undefined,
      };
    }

    case 'videoMessage': {
      const video = content.videoMessage;
      return {
        type: 'video',
        mediaId: msg.key?.id ?? '',
        mimeType: video?.mimetype ?? 'video/mp4',
        caption: video?.caption ?? undefined,
        duration: video?.seconds ?? undefined,
        fileSize: video?.fileLength ? Number(video.fileLength) : undefined,
      };
    }

    case 'documentMessage':
    case 'documentWithCaptionMessage': {
      const doc = contentType === 'documentWithCaptionMessage'
        ? content.documentWithCaptionMessage?.message?.documentMessage
        : content.documentMessage;
      return {
        type: 'document',
        mediaId: msg.key?.id ?? '',
        mimeType: doc?.mimetype ?? 'application/octet-stream',
        fileName: doc?.fileName ?? 'document',
        caption: doc?.caption ?? undefined,
        fileSize: doc?.fileLength ? Number(doc.fileLength) : undefined,
      };
    }

    case 'stickerMessage': {
      const sticker = content.stickerMessage;
      return {
        type: 'sticker',
        mediaId: msg.key?.id ?? '',
        mimeType: sticker?.mimetype ?? 'image/webp',
        isAnimated: sticker?.isAnimated ?? false,
      };
    }

    case 'locationMessage': {
      const loc = content.locationMessage;
      return {
        type: 'location',
        latitude: loc?.degreesLatitude ?? 0,
        longitude: loc?.degreesLongitude ?? 0,
        name: loc?.name ?? undefined,
        address: loc?.address ?? undefined,
      };
    }

    case 'liveLocationMessage': {
      const liveLoc = content.liveLocationMessage;
      return {
        type: 'location',
        latitude: liveLoc?.degreesLatitude ?? 0,
        longitude: liveLoc?.degreesLongitude ?? 0,
      };
    }

    case 'contactMessage': {
      const contact = content.contactMessage;
      return {
        type: 'contact',
        contacts: [{
          name: { formatted: contact?.displayName ?? 'Unknown' },
          phones: extractPhonesFromVCard(contact?.vcard ?? ''),
        }],
      };
    }

    case 'contactsArrayMessage': {
      const contacts = content.contactsArrayMessage?.contacts ?? [];
      return {
        type: 'contact',
        contacts: contacts.map((c) => ({
          name: { formatted: c.displayName ?? 'Unknown' },
          phones: extractPhonesFromVCard(c.vcard ?? ''),
        })),
      };
    }

    case 'reactionMessage': {
      const reaction = content.reactionMessage;
      return {
        type: 'reaction',
        emoji: reaction?.text ?? '',
        targetMessageId: reaction?.key?.id ?? '',
      };
    }

    default:
      return { type: 'text', body: `[Unsupported message type: ${contentType ?? 'unknown'}]` };
  }
}

function mapContext(msg: WAMessage): WhatsAppMessageContext {
  const content = extractMessageContent(msg.message);
  const contentType = content ? getContentType(content) : undefined;

  let contextInfo: proto.IContextInfo | null | undefined;
  if (content && contentType) {
    const msgContent = content[contentType] as Record<string, unknown> | undefined;
    contextInfo = msgContent?.['contextInfo'] as proto.IContextInfo | null | undefined;
  }

  return {
    isForwarded: (contextInfo?.isForwarded ?? false) as boolean,
    forwardingScore: contextInfo?.forwardingScore ?? undefined,
    isFrequentlyForwarded: (contextInfo?.forwardingScore ?? 0) >= 5,
    mentionedIds: contextInfo?.mentionedJid
      ? contextInfo.mentionedJid.filter((jid): jid is string => typeof jid === 'string')
      : undefined,
    isEphemeral: (contextInfo?.expiration ?? 0) > 0,
    ephemeralDuration: contextInfo?.expiration ?? undefined,
    isFromStatusBroadcast: msg.key?.remoteJid === 'status@broadcast',
    isViewOnce: !!msg.message?.viewOnceMessage || !!msg.message?.viewOnceMessageV2,
  };
}

function extractPhonesFromVCard(vcard: string): Array<{ phone: string; type?: string }> {
  const phones: Array<{ phone: string; type?: string }> = [];
  const regex = /TEL(?:;[^:]*)?:(.+)/g;
  let match;
  while ((match = regex.exec(vcard)) !== null) {
    if (match[1]) {
      phones.push({ phone: match[1].trim() });
    }
  }
  return phones;
}
