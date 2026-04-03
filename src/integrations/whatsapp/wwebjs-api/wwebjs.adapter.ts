import type { MessagingPort } from '../../../core/messaging/messaging.port.js';
import type { OutboundMessage } from '../../../core/messaging/outbound-message.js';
import type { MediaContent, MessageResult, MessageStatus } from '../../../core/messaging/message-result.js';
import { ProviderError } from '../../../core/errors.js';
import type {
  WwebjsSendMessageRequest,
  WwebjsSendResponse,
  WwebjsDownloadMediaResponse,
  WwebjsMessageInfoResponse,
} from './wwebjs.types.js';

/** Parse a credential string that may contain connection info (apiKey or apiKey@host:port) */
function parseCredential(raw: string): { apiKey: string; baseUrl?: string } {
  const atIndex = raw.lastIndexOf('@');
  if (atIndex === -1) return { apiKey: raw };
  const apiKey = raw.substring(0, atIndex);
  const hostPort = raw.substring(atIndex + 1);
  if (!apiKey || !hostPort) return { apiKey: raw };
  const baseUrl = hostPort.startsWith('http') ? hostPort : `http://${hostPort}`;
  return { apiKey, baseUrl };
}

export class WwebjsApiAdapter implements MessagingPort {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly sessionId: string;

  constructor(
    providerConfig: Record<string, unknown>,
    credentialsRef: string,
    inlineCredential?: string,
  ) {
    const configBaseUrl = (providerConfig['baseUrl'] as string | undefined) ?? 'http://localhost:3001';
    const configSessionId = providerConfig['sessionId'] as string | undefined;
    const raw = inlineCredential ?? '';
    const parsed = raw ? parseCredential(raw) : undefined;

    const rawApiKey = parsed?.apiKey ?? '';

    // Support sessionId:apiKey format in credential
    const colonIdx = rawApiKey.indexOf(':');
    if (colonIdx !== -1) {
      this.sessionId = rawApiKey.substring(0, colonIdx);
      this.apiKey = rawApiKey.substring(colonIdx + 1);
    } else {
      this.sessionId = configSessionId ?? 'default';
      this.apiKey = rawApiKey;
    }

    this.baseUrl = parsed?.baseUrl ?? configBaseUrl;
  }

  async sendMessage(msg: OutboundMessage): Promise<MessageResult> {
    const chatId = this.formatChatId(msg.to);

    const body: WwebjsSendMessageRequest = this.buildSendBody(chatId, msg);

    const response = await this.request<WwebjsSendResponse>(
      `/client/sendMessage/${this.sessionId}`,
      'POST',
      body as unknown as Record<string, unknown>,
    );

    if (!response.success) {
      throw new ProviderError('wwebjs-api', response.error ?? 'Send failed');
    }

    const messageId = response.message?.id?._serialized ?? '';

    return {
      messageId,
      status: 'sent',
      timestamp: new Date(),
      providerMessageId: messageId,
    };
  }

  async getMessageStatus(messageId: string): Promise<MessageStatus> {
    // wwebjs-api requires chatId + messageId; extract from composite "chatId|messageId" format
    const { chatId, msgId } = this.parseCompositeId(messageId);

    const response = await this.request<WwebjsMessageInfoResponse>(
      `/message/getInfo/${this.sessionId}`,
      'POST',
      { messageId: msgId, chatId },
    );

    if (!response.success || !response.info) {
      return { messageId: msgId, status: 'unknown', timestamp: new Date() };
    }

    const info = response.info;
    let status: MessageStatus['status'] = 'sent';
    if (info.played && info.played.length > 0) status = 'played';
    else if (info.read && info.read.length > 0) status = 'read';
    else if (info.delivery && info.delivery.length > 0) status = 'delivered';

    return {
      messageId: msgId,
      status,
      timestamp: new Date(),
      providerMessageId: msgId,
    };
  }

  async downloadMedia(mediaId: string): Promise<MediaContent> {
    // wwebjs-api requires chatId + messageId; extract from composite "chatId|messageId" format
    const { chatId, msgId } = this.parseCompositeId(mediaId);

    const response = await this.request<WwebjsDownloadMediaResponse>(
      `/message/downloadMedia/${this.sessionId}`,
      'POST',
      { messageId: msgId, chatId },
    );

    if (!response.success || !response.messageMedia) {
      throw new ProviderError('wwebjs-api', response.error ?? 'Media download failed');
    }

    const media = response.messageMedia;
    const buffer = Buffer.from(media.data, 'base64');

    return {
      data: buffer,
      mimeType: media.mimetype,
      fileName: media.filename,
      size: media.filesize ?? buffer.length,
    };
  }

  async markAsRead(messageId: string): Promise<void> {
    // wwebjs-api sendSeen works at chat level
    const { chatId } = this.parseCompositeId(messageId);

    await this.request(
      `/client/sendSeen/${this.sessionId}`,
      'POST',
      { chatId },
    );
  }

  private buildSendBody(chatId: string, msg: OutboundMessage): WwebjsSendMessageRequest {
    const options: Record<string, unknown> = {};
    if (msg.replyToMessageId) {
      options['quotedMessageId'] = msg.replyToMessageId;
    }

    switch (msg.content.type) {
      case 'text':
        return {
          chatId,
          content: msg.content.body ?? '',
          contentType: 'string',
          ...(Object.keys(options).length > 0 && { options }),
        };

      case 'image':
      case 'audio':
      case 'video':
      case 'document':
        if (msg.content.caption) {
          options['caption'] = msg.content.caption;
        }
        return {
          chatId,
          content: { url: msg.content.mediaUrl ?? '' },
          contentType: 'MessageMediaFromURL',
          ...(Object.keys(options).length > 0 && { options }),
        };

      case 'location':
        return {
          chatId,
          content: {
            latitude: msg.content.latitude ?? 0,
            longitude: msg.content.longitude ?? 0,
          },
          contentType: 'Location',
        };

      default:
        return {
          chatId,
          content: msg.content.body ?? '',
          contentType: 'string',
          ...(Object.keys(options).length > 0 && { options }),
        };
    }
  }

  private parseCompositeId(compositeId: string): { chatId: string; msgId: string } {
    const separatorIdx = compositeId.indexOf('|');
    if (separatorIdx === -1) {
      return { chatId: compositeId, msgId: compositeId };
    }
    return {
      chatId: compositeId.substring(0, separatorIdx),
      msgId: compositeId.substring(separatorIdx + 1),
    };
  }

  private formatChatId(to: string): string {
    const cleaned = to.replace(/[^0-9]/g, '');
    return `${cleaned}@c.us`;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['x-api-key'] = this.apiKey;
    }
    return headers;
  }

  private async request<T>(path: string, method: string, body?: Record<string, unknown>): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    const response = await fetch(url, {
      method,
      headers: this.buildHeaders(),
      ...(body && { body: JSON.stringify(body) }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => 'Unknown error');
      throw new ProviderError('wwebjs-api', `HTTP ${response.status}: ${text}`, response.status);
    }

    return response.json() as Promise<T>;
  }
}
