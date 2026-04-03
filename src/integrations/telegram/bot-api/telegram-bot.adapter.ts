import type { MessagingPort } from '../../../core/messaging/messaging.port.js';
import type { OutboundMessage } from '../../../core/messaging/outbound-message.js';
import type { MediaContent, MessageResult, MessageStatus } from '../../../core/messaging/message-result.js';
import { ProviderError } from '../../../core/errors.js';

interface TelegramApiResponse {
  ok: boolean;
  result?: {
    message_id?: number;
    file_path?: string;
    file_id?: string;
  };
  description?: string;
}

export class TelegramBotAdapter implements MessagingPort {
  private readonly token: string;
  private readonly baseUrl: string;

  constructor(
    _providerConfig: Record<string, unknown>,
    _credentialsRef: string,
    inlineCredential?: string,
  ) {
    this.token = inlineCredential ?? '';
    this.baseUrl = `https://api.telegram.org/bot${this.token}`;
  }

  async sendMessage(msg: OutboundMessage): Promise<MessageResult> {
    const chatId = msg.to;

    switch (msg.content.type) {
      case 'text':
        return this.callSendApi('sendMessage', {
          chat_id: chatId,
          text: msg.content.body ?? '',
          ...(msg.replyToMessageId && { reply_to_message_id: Number(msg.replyToMessageId) }),
        });

      case 'image':
        return this.callSendApi('sendPhoto', {
          chat_id: chatId,
          photo: msg.content.mediaUrl ?? '',
          ...(msg.content.caption && { caption: msg.content.caption }),
          ...(msg.replyToMessageId && { reply_to_message_id: Number(msg.replyToMessageId) }),
        });

      case 'audio':
        return this.callSendApi('sendAudio', {
          chat_id: chatId,
          audio: msg.content.mediaUrl ?? '',
          ...(msg.content.caption && { caption: msg.content.caption }),
          ...(msg.replyToMessageId && { reply_to_message_id: Number(msg.replyToMessageId) }),
        });

      case 'video':
        return this.callSendApi('sendVideo', {
          chat_id: chatId,
          video: msg.content.mediaUrl ?? '',
          ...(msg.content.caption && { caption: msg.content.caption }),
          ...(msg.replyToMessageId && { reply_to_message_id: Number(msg.replyToMessageId) }),
        });

      case 'document':
        return this.callSendApi('sendDocument', {
          chat_id: chatId,
          document: msg.content.mediaUrl ?? '',
          ...(msg.content.caption && { caption: msg.content.caption }),
          ...(msg.replyToMessageId && { reply_to_message_id: Number(msg.replyToMessageId) }),
        });

      case 'location':
        return this.callSendApi('sendLocation', {
          chat_id: chatId,
          latitude: msg.content.latitude ?? 0,
          longitude: msg.content.longitude ?? 0,
          ...(msg.replyToMessageId && { reply_to_message_id: Number(msg.replyToMessageId) }),
        });

      default:
        // Fallback: send as text
        return this.callSendApi('sendMessage', {
          chat_id: chatId,
          text: msg.content.body ?? `[Unsupported content type: ${msg.content.type}]`,
          ...(msg.replyToMessageId && { reply_to_message_id: Number(msg.replyToMessageId) }),
        });
    }
  }

  async getMessageStatus(_messageId: string): Promise<MessageStatus> {
    // Telegram Bot API does not provide delivery receipts
    return {
      messageId: _messageId,
      status: 'unknown',
      timestamp: new Date(),
    };
  }

  async downloadMedia(mediaId: string): Promise<MediaContent> {
    // Step 1: getFile to obtain file_path
    const fileResponse = await this.callApi<TelegramApiResponse>('getFile', {
      file_id: mediaId,
    });

    if (!fileResponse.ok || !fileResponse.result?.file_path) {
      throw new ProviderError('telegram-bot-api', fileResponse.description ?? 'getFile failed');
    }

    const filePath = fileResponse.result.file_path;

    // Step 2: Download the file
    const downloadUrl = `https://api.telegram.org/file/bot${this.token}/${filePath}`;
    const response = await fetch(downloadUrl);

    if (!response.ok) {
      throw new ProviderError(
        'telegram-bot-api',
        `File download failed: HTTP ${response.status}`,
        response.status,
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const mimeType = response.headers.get('content-type') ?? 'application/octet-stream';

    // Extract filename from file_path
    const fileName = filePath.split('/').pop() ?? 'file';

    return {
      data: buffer,
      mimeType,
      fileName,
      size: buffer.length,
    };
  }

  async markAsRead(_messageId: string): Promise<void> {
    // Telegram Bot API does not support marking messages as read
  }

  private async callSendApi(
    method: string,
    params: Record<string, unknown>,
  ): Promise<MessageResult> {
    const response = await this.callApi<TelegramApiResponse>(method, params);

    if (!response.ok) {
      throw new ProviderError(
        'telegram-bot-api',
        response.description ?? `${method} failed`,
      );
    }

    const messageId = String(response.result?.message_id ?? '');

    return {
      messageId,
      status: 'sent',
      timestamp: new Date(),
      providerMessageId: messageId,
    };
  }

  private async callApi<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const url = `${this.baseUrl}/${method}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      // Still try to parse for Telegram error description
      try {
        return await response.json() as T;
      } catch {
        throw new ProviderError(
          'telegram-bot-api',
          `HTTP ${response.status}`,
          response.status,
        );
      }
    }

    return response.json() as Promise<T>;
  }
}
