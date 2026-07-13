import type { MessagingPort } from '../../../core/messaging/messaging.port.js';
import type { OutboundMessage } from '../../../core/messaging/outbound-message.js';
import type { MediaContent, MessageResult, MessageStatus } from '../../../core/messaging/message-result.js';
import { ProviderError } from '../../../core/errors.js';
import { fetchWithTimeout } from '../../shared/http.js';
import type { MattermostPost } from '../mattermost-channel.types.js';

interface MattermostCreatePostResponse {
  id: string;
  channel_id: string;
  message: string;
  create_at: number;
}

interface MattermostFileInfo {
  id: string;
  name: string;
  mime_type: string;
  size: number;
}

interface MattermostFileUploadResponse {
  file_infos: MattermostFileInfo[];
}

export class MattermostAdapter implements MessagingPort {
  private readonly serverUrl: string;
  private readonly token: string;

  constructor(
    providerConfig: Record<string, unknown>,
    _credentialsRef: string,
    inlineCredential?: string,
  ) {
    this.serverUrl = (providerConfig.serverUrl as string) ?? '';
    this.token = inlineCredential ?? '';
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` };
  }

  async sendMessage(msg: OutboundMessage): Promise<MessageResult> {
    const channelId = msg.to;

    // Resolve root_id for threaded replies
    let rootId: string | undefined;
    if (msg.replyToMessageId) {
      rootId = await this.resolveRootId(msg.replyToMessageId);
    }

    // Handle media content
    if (msg.content.mediaUrl) {
      return this.sendWithMedia(msg, channelId, rootId);
    }

    // Text-only post
    return this.createPost(channelId, msg.content.body ?? '', rootId);
  }

  private async sendWithMedia(
    msg: OutboundMessage,
    channelId: string,
    rootId: string | undefined,
  ): Promise<MessageResult> {
    // Step 1: upload the file
    const fileIds = await this.uploadFile(channelId, msg);

    // Step 2: create the post with file_ids
    const response = await this.callApi<MattermostCreatePostResponse>(
      'POST',
      '/api/v4/posts',
      {
        channel_id: channelId,
        message: msg.content.body ?? '',
        file_ids: fileIds,
        ...(rootId && { root_id: rootId }),
      },
    );

    return {
      messageId: response.id,
      status: 'sent',
      timestamp: new Date(),
      providerMessageId: response.id,
    };
  }

  private async uploadFile(
    channelId: string,
    msg: OutboundMessage,
  ): Promise<string[]> {
    const mediaUrl = msg.content.mediaUrl;
    if (!mediaUrl) return [];

    // Download the media
    const mediaResponse = await fetchWithTimeout(mediaUrl, { method: 'GET' }, 30_000);
    if (!mediaResponse.ok) {
      throw new ProviderError(
        'mattermost',
        `Media download failed: HTTP ${mediaResponse.status}`,
        mediaResponse.status,
      );
    }

    const arrayBuffer = await mediaResponse.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const mimeType = msg.content.mimeType ?? mediaResponse.headers.get('content-type') ?? 'application/octet-stream';
    const fileName = msg.content.fileName ?? mediaUrl.split('/').pop() ?? 'file';

    // Upload to Mattermost
    const boundary = `----FormBoundary${Date.now()}`;
    const parts: Buffer[] = [];

    // channel_id field
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="channel_id"\r\n\r\n${channelId}\r\n`,
    ));

    // files field
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
    ));
    parts.push(buffer);
    parts.push(Buffer.from('\r\n'));
    parts.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    const response = await fetchWithTimeout(
      `${this.serverUrl}/api/v4/files`,
      {
        method: 'POST',
        headers: {
          ...this.authHeaders(),
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
      },
      30_000,
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ProviderError(
        'mattermost',
        `File upload failed: HTTP ${response.status} - ${text}`,
        response.status,
      );
    }

    const result = await response.json() as MattermostFileUploadResponse;
    return result.file_infos.map((f) => f.id);
  }

  private async createPost(
    channelId: string,
    message: string,
    rootId?: string,
  ): Promise<MessageResult> {
    const response = await this.callApi<MattermostCreatePostResponse>(
      'POST',
      '/api/v4/posts',
      {
        channel_id: channelId,
        message,
        ...(rootId && { root_id: rootId }),
      },
    );

    return {
      messageId: response.id,
      status: 'sent',
      timestamp: new Date(),
      providerMessageId: response.id,
    };
  }

  /**
   * Resolve the thread root for a reply. If the target post is itself a reply,
   * return its root_id instead (Mattermost requires the actual root post id).
   */
  private async resolveRootId(postId: string): Promise<string> {
    try {
      const post = await this.callApi<MattermostPost>(
        'GET',
        `/api/v4/posts/${postId}`,
      );
      // If this post has a root_id, it's a reply — use its root
      return post.root_id ?? postId;
    } catch {
      // Fallback: use the postId directly
      return postId;
    }
  }

  async downloadMedia(mediaId: string): Promise<MediaContent> {
    const response = await fetchWithTimeout(
      `${this.serverUrl}/api/v4/files/${mediaId}`,
      {
        method: 'GET',
        headers: this.authHeaders(),
      },
      30_000,
    );

    if (!response.ok) {
      throw new ProviderError(
        'mattermost',
        `File download failed: HTTP ${response.status}`,
        response.status,
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const mimeType = response.headers.get('content-type') ?? 'application/octet-stream';

    return {
      data: buffer,
      mimeType,
      size: buffer.length,
    };
  }

  async getMessageStatus(_messageId: string): Promise<MessageStatus> {
    return {
      messageId: _messageId,
      status: 'unknown',
      timestamp: new Date(),
    };
  }

  async markAsRead(_messageId: string): Promise<void> {
    // Mattermost Bot API does not support marking messages as read
  }

  private async callApi<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const url = `${this.serverUrl}${path}`;
    const init: RequestInit = {
      method,
      headers: {
        ...this.authHeaders(),
        'Content-Type': 'application/json',
      },
      ...(body && { body: JSON.stringify(body) }),
    };

    const response = await fetchWithTimeout(url, init, 15_000);

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ProviderError(
        'mattermost',
        `API ${method} ${path} failed: HTTP ${response.status} - ${text}`,
        response.status,
      );
    }

    return response.json() as Promise<T>;
  }
}
