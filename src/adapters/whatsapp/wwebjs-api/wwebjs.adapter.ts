import type { MessagingPort } from '../../../domain/messaging/messaging.port.js';
import type { OutboundMessage } from '../../../domain/messaging/outbound-message.js';
import type { MediaContent, MessageResult, MessageStatus } from '../../../domain/messaging/message-result.js';
import { ProviderError } from '../../../domain/errors.js';
import { resolveProviderCredentialParsed } from '../../../infrastructure/config/env.config.js';
import type { WwebjsSendResponse, WwebjsMessageStatusResponse } from './wwebjs.types.js';

export class WwebjsApiAdapter implements MessagingPort {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(
    providerConfig: Record<string, unknown>,
    credentialsRef: string,
  ) {
    const configBaseUrl = (providerConfig['baseUrl'] as string | undefined) ?? 'http://localhost:3001';
    const parsed = resolveProviderCredentialParsed(credentialsRef, 'wwebjs-api');
    this.apiKey = parsed?.apiKey ?? '';
    this.baseUrl = parsed?.baseUrl ?? configBaseUrl;
  }

  async sendMessage(msg: OutboundMessage): Promise<MessageResult> {
    const chatId = this.formatChatId(msg.to);

    let endpoint: string;
    let body: Record<string, unknown>;

    switch (msg.content.type) {
      case 'text':
        endpoint = '/api/sendText';
        body = {
          chatId,
          text: msg.content.body ?? '',
          ...(msg.replyToMessageId && { quotedMessageId: msg.replyToMessageId }),
        };
        break;

      case 'image':
      case 'audio':
      case 'video':
      case 'document':
        endpoint = '/api/sendMedia';
        body = {
          chatId,
          mediaUrl: msg.content.mediaUrl,
          mimeType: msg.content.mimeType ?? 'application/octet-stream',
          fileName: msg.content.fileName,
          caption: msg.content.caption,
          ...(msg.replyToMessageId && { quotedMessageId: msg.replyToMessageId }),
        };
        break;

      case 'location':
        endpoint = '/api/sendLocation';
        body = {
          chatId,
          latitude: msg.content.latitude,
          longitude: msg.content.longitude,
        };
        break;

      default:
        endpoint = '/api/sendText';
        body = { chatId, text: msg.content.body ?? '' };
    }

    const response = await this.request<WwebjsSendResponse>(endpoint, 'POST', body);

    if (!response.success) {
      throw new ProviderError('wwebjs-api', response.error ?? 'Send failed');
    }

    return {
      messageId: response.messageId ?? '',
      status: 'sent',
      timestamp: new Date(),
      providerMessageId: response.messageId,
    };
  }

  async getMessageStatus(messageId: string): Promise<MessageStatus> {
    const response = await this.request<WwebjsMessageStatusResponse>(
      `/api/message/${encodeURIComponent(messageId)}/status`,
      'GET',
    );

    const statusMap: Record<string, MessageStatus['status']> = {
      pending: 'queued',
      sent: 'sent',
      delivered: 'delivered',
      read: 'read',
      played: 'played',
      error: 'failed',
    };

    return {
      messageId,
      status: statusMap[response.status] ?? 'unknown',
      timestamp: response.timestamp ? new Date(response.timestamp) : new Date(),
      providerMessageId: response.messageId,
    };
  }

  async downloadMedia(mediaId: string): Promise<MediaContent> {
    const response = await fetch(`${this.baseUrl}/api/media/${encodeURIComponent(mediaId)}`, {
      headers: this.buildHeaders(),
    });

    if (!response.ok) {
      throw new ProviderError('wwebjs-api', `Media download failed: ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') ?? 'application/octet-stream';

    return {
      data: buffer,
      mimeType: contentType,
      size: buffer.length,
    };
  }

  async markAsRead(messageId: string): Promise<void> {
    await this.request(`/api/message/${encodeURIComponent(messageId)}/read`, 'POST', {});
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
      headers['Authorization'] = `Bearer ${this.apiKey}`;
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
