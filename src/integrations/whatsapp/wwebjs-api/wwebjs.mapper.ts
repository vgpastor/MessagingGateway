import type {
  WhatsAppInboundEvent,
  WhatsAppContact,
  WhatsAppChat,
  WhatsAppMessage,
  WhatsAppMessageContext,
  WhatsAppSystemEventType,
} from '../whatsapp-channel.types.js';
import type { WwebjsInboundPayload } from './wwebjs.types.js';

export function mapWwebjsToWhatsAppEvent(payload: WwebjsInboundPayload): WhatsAppInboundEvent {
  const data = payload.data;

  return {
    messageId: data.id._serialized,
    from: mapContact(data),
    chat: mapChat(data),
    message: mapMessage(data),
    context: mapContext(data),
    raw: payload,
  };
}

function mapContact(data: WwebjsInboundPayload['data']): WhatsAppContact {
  return {
    wid: data.from,
    pushName: data.notifyName,
    isBusinessAccount: false,
    isBroadcast: data.isStatus ?? false,
  };
}

function mapChat(data: WwebjsInboundPayload['data']): WhatsAppChat {
  const chat: WhatsAppChat = {
    chatId: data.chat?.id._serialized ?? data.from,
    isGroup: data.chat?.isGroup ?? false,
  };

  if (data.chat?.groupMetadata) {
    const gm = data.chat.groupMetadata;
    chat.groupMetadata = {
      name: gm.subject,
      description: gm.desc,
      participants: gm.participants.map((p) => ({
        wid: p.id._serialized,
        isAdmin: p.isAdmin,
        isSuperAdmin: p.isSuperAdmin,
      })),
      admins: gm.participants
        .filter((p) => p.isAdmin || p.isSuperAdmin)
        .map((p) => p.id._serialized),
      createdAt: new Date(gm.creation * 1000),
      isAnnouncement: gm.announce,
    };
  }

  return chat;
}

function mapMessage(data: WwebjsInboundPayload['data']): WhatsAppMessage {
  switch (data.type) {
    case 'chat':
      return { type: 'text', body: data.body ?? '' };

    case 'image':
      return {
        type: 'image',
        mediaId: data.id._serialized,
        mimeType: data.mimetype ?? 'image/jpeg',
        caption: data.caption,
        mediaUrl: data.mediaUrl,
        fileSize: data.filesize,
      };

    case 'ptt':
    case 'audio':
      return {
        type: 'audio',
        mediaId: data.id._serialized,
        mimeType: data.mimetype ?? 'audio/ogg',
        isVoiceNote: data.type === 'ptt',
        duration: data.duration,
        mediaUrl: data.mediaUrl,
        fileSize: data.filesize,
      };

    case 'video':
      return {
        type: 'video',
        mediaId: data.id._serialized,
        mimeType: data.mimetype ?? 'video/mp4',
        caption: data.caption,
        duration: data.duration,
        mediaUrl: data.mediaUrl,
        fileSize: data.filesize,
      };

    case 'document':
      return {
        type: 'document',
        mediaId: data.id._serialized,
        mimeType: data.mimetype ?? 'application/octet-stream',
        fileName: data.filename ?? 'document',
        caption: data.caption,
        mediaUrl: data.mediaUrl,
        fileSize: data.filesize,
      };

    case 'sticker':
      return {
        type: 'sticker',
        mediaId: data.id._serialized,
        mimeType: data.mimetype ?? 'image/webp',
        isAnimated: data.isGif ?? false,
        mediaUrl: data.mediaUrl,
      };

    case 'location':
    case 'live_location':
      return {
        type: 'location',
        latitude: data.location?.latitude ?? 0,
        longitude: data.location?.longitude ?? 0,
        name: data.location?.description,
      };

    case 'vcard':
    case 'multi_vcard':
      return {
        type: 'contact',
        contacts: (data.vCards ?? []).map((vcard) => ({
          name: { formatted: extractNameFromVCard(vcard) },
          phones: extractPhonesFromVCard(vcard),
        })),
      };

    case 'reaction':
      return {
        type: 'reaction',
        emoji: data.body ?? '',
        targetMessageId: '',
      };

    case 'e2e_notification':
    case 'notification':
    case 'notification_template':
    case 'gp2':
      return {
        type: 'system',
        eventType: mapSystemEventType(data.type, data.body),
        body: data.body,
      };

    case 'call_log':
      return {
        type: 'call',
        callId: data.id._serialized,
        isVideo: false,
        status: 'missed',
        duration: data.duration,
      };

    default:
      return { type: 'text', body: data.body ?? `[Unsupported message type: ${data.type}]` };
  }
}

function mapContext(data: WwebjsInboundPayload['data']): WhatsAppMessageContext {
  return {
    isForwarded: data.isForwarded ?? false,
    forwardingScore: data.forwardingScore,
    isFrequentlyForwarded: (data.forwardingScore ?? 0) >= 5,
    mentionedIds: data.mentionedIds,
    isEphemeral: data.isEphemeral ?? false,
    isFromStatusBroadcast: data.isStatus ?? false,
    isViewOnce: false,
  };
}

function mapSystemEventType(_type: string, body?: string): WhatsAppSystemEventType {
  if (body?.includes('created group')) return 'group_created';
  if (body?.includes('added')) return 'participant_added';
  if (body?.includes('removed')) return 'participant_removed';
  if (body?.includes('promoted')) return 'participant_promoted';
  if (body?.includes('demoted')) return 'participant_demoted';
  return 'unknown';
}

function extractNameFromVCard(vcard: string): string {
  const fnMatch = vcard.match(/FN:(.*)/);
  return fnMatch?.[1]?.trim() ?? 'Unknown';
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