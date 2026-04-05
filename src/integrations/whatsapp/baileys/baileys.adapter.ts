import { type WASocket, jidNormalizedUser } from '@whiskeysockets/baileys';
import type { MessagingPort } from '../../../core/messaging/messaging.port.js';
import type { OutboundMessage } from '../../../core/messaging/outbound-message.js';
import type { MediaContent, MessageResult, MessageStatus } from '../../../core/messaging/message-result.js';
import { ProviderError } from '../../../core/errors.js';
import type { BaileysSocketManager } from './baileys-socket.manager.js';

export class BaileysAdapter implements MessagingPort {
  private readonly accountId: string;

  constructor(
    providerConfig: Record<string, unknown>,
    credentialsRef: string,
    _inlineCredential: string | undefined,
    private readonly socketManager: BaileysSocketManager,
  ) {
    this.accountId = (providerConfig['accountId'] as string | undefined) ?? credentialsRef;
  }

  async sendMessage(msg: OutboundMessage): Promise<MessageResult> {
    const socket = this.getSocketOrThrow();
    const jid = this.formatJid(msg.to);

    try {
      const baileysMsg = this.buildBaileysMessage(msg);
      const quotedOptions = msg.replyToMessageId
        ? { quoted: { key: { remoteJid: jid, id: msg.replyToMessageId }, message: {} } }
        : undefined;

      const response = await socket.sendMessage(
        jid,
        baileysMsg,
        quotedOptions as Parameters<WASocket['sendMessage']>[2],
      );

      const messageId = response?.key?.id ?? `baileys-${Date.now()}`;

      return {
        messageId,
        status: 'sent',
        timestamp: new Date(),
        providerMessageId: messageId,
        remoteJid: response?.key?.remoteJid ? jidNormalizedUser(response.key.remoteJid) : undefined,
      };
    } catch (error) {
      throw new ProviderError(
        'baileys',
        error instanceof Error ? error.message : 'Send failed',
      );
    }
  }

  async getMessageStatus(_messageId: string): Promise<MessageStatus> {
    return {
      messageId: _messageId,
      status: 'unknown',
      timestamp: new Date(),
    };
  }

  async downloadMedia(mediaId: string): Promise<MediaContent> {
    // Baileys requires the full WAMessage object to download media.
    // Media download should be done at the time the message is received
    // (in the inbound handler) rather than later by ID.
    // This method serves as a fallback for API compatibility.
    void this.getSocketOrThrow(); // ensure connected
    const { msgId } = this.parseCompositeId(mediaId);

    throw new ProviderError(
      'baileys',
      `Direct media download by ID (${msgId}) is not supported. ` +
      'Download media when the message is received via the inbound handler.',
    );
  }

  async markAsRead(messageId: string): Promise<void> {
    const socket = this.getSocketOrThrow();
    const { remoteJid, msgId } = this.parseCompositeId(messageId);

    try {
      await socket.readMessages([{ remoteJid, id: msgId }]);
    } catch (error) {
      throw new ProviderError(
        'baileys',
        error instanceof Error ? error.message : 'Mark as read failed',
      );
    }
  }

  private buildBaileysMessage(msg: OutboundMessage): Parameters<WASocket['sendMessage']>[1] {
    switch (msg.content.type) {
      case 'text':
        return { text: msg.content.body ?? '' };

      case 'image':
        return {
          image: { url: msg.content.mediaUrl ?? '' },
          caption: msg.content.caption,
          mimetype: msg.content.mimeType,
        };

      case 'video':
        return {
          video: { url: msg.content.mediaUrl ?? '' },
          caption: msg.content.caption,
          mimetype: msg.content.mimeType,
        };

      case 'audio':
        return {
          audio: { url: msg.content.mediaUrl ?? '' },
          mimetype: msg.content.mimeType ?? 'audio/mp4',
        };

      case 'document':
        return {
          document: { url: msg.content.mediaUrl ?? '' },
          mimetype: msg.content.mimeType ?? 'application/octet-stream',
          fileName: msg.content.fileName ?? 'document',
        };

      case 'location':
        return {
          location: {
            degreesLatitude: msg.content.latitude ?? 0,
            degreesLongitude: msg.content.longitude ?? 0,
          },
        };

      case 'reaction':
        return {
          react: {
            text: msg.content.body ?? '',
            key: {
              remoteJid: this.formatJid(msg.to),
              id: msg.replyToMessageId ?? '',
            },
          },
        };

      default:
        return { text: msg.content.body ?? '' };
    }
  }

  private getSocketOrThrow(): WASocket {
    const socket = this.socketManager.getSocket(this.accountId);
    if (!socket) {
      throw new ProviderError('baileys', `No active connection for account '${this.accountId}'`);
    }
    return socket;
  }

  private formatJid(to: string): string {
    if (to.includes('@')) return to;
    const cleaned = to.replace(/[^0-9]/g, '');
    return `${cleaned}@s.whatsapp.net`;
  }

  private parseCompositeId(compositeId: string): { remoteJid: string; msgId: string } {
    const separatorIdx = compositeId.indexOf('|');
    if (separatorIdx === -1) {
      return { remoteJid: compositeId, msgId: compositeId };
    }
    return {
      remoteJid: compositeId.substring(0, separatorIdx),
      msgId: compositeId.substring(separatorIdx + 1),
    };
  }
}
