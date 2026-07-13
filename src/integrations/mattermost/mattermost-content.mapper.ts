import { randomUUID as uuid } from 'node:crypto';
import type { MessageContent, ChannelDetails } from '../../core/messaging/content.js';
import type { UnifiedEnvelope } from '../../core/messaging/unified-envelope.js';
import type { ChannelAccount } from '../../core/accounts/channel-account.js';
import type { MattermostPost, MattermostFileInfo } from './mattermost-channel.types.js';

/** Convert a Mattermost post to standardised MessageContent */
export function mapPostToContent(post: MattermostPost): MessageContent {
  const fileIds = post.file_ids;
  if (!fileIds || fileIds.length === 0) {
    return { type: 'text', body: post.message };
  }

  // Best-effort: use first file's metadata from post metadata
  const firstFileId = fileIds[0]!;
  const metaFiles = post.metadata?.files;
  const firstMeta = metaFiles?.find((f: MattermostFileInfo) => f.id === firstFileId);

  if (firstMeta) {
    const mime = firstMeta.mime_type ?? 'application/octet-stream';
    const ext = firstMeta.extension?.toLowerCase() ?? '';

    if (fileIds.length === 1) {
      if (mime.startsWith('image/')) {
        return {
          type: 'image',
          media: { id: firstFileId, mimeType: mime, size: firstMeta.size },
          caption: post.message || undefined,
        };
      }
      if (mime.startsWith('audio/')) {
        return { type: 'audio', media: { id: firstFileId, mimeType: mime, size: firstMeta.size } };
      }
      if (mime.startsWith('video/')) {
        return {
          type: 'video',
          media: { id: firstFileId, mimeType: mime, size: firstMeta.size },
          caption: post.message || undefined,
        };
      }
      return {
        type: 'document',
        media: { id: firstFileId, mimeType: mime, size: firstMeta.size },
        fileName: firstMeta.name ?? `file.${ext}`,
        caption: post.message || undefined,
      };
    }
  }

  // WebSocket events include file_ids but not metadata.files — treat as image
  // (the most common case). The media ID can be used to download via the adapter.
  if (fileIds.length === 1) {
    return {
      type: 'image',
      media: { id: firstFileId, mimeType: 'application/octet-stream' },
      caption: post.message || undefined,
    };
  }

  // Multiple files → document with first file
  return {
    type: 'document',
    media: { id: firstFileId, mimeType: 'application/octet-stream' },
    fileName: `file-${firstFileId}`,
    caption: post.message || undefined,
  };
}

/** Build Mattermost-specific channel details */
export function mapMattermostChannelDetails(post: MattermostPost): ChannelDetails {
  return {
    platform: 'mattermost',
    postId: post.id,
    channelId: post.channel_id,
    rootId: post.root_id,
    parentId: post.parent_id,
    replyCount: post.reply_count,
  };
}

/** Build a fully standardised UnifiedEnvelope from a Mattermost post */
export function buildMattermostEnvelope(
  post: MattermostPost,
  account: ChannelAccount,
): UnifiedEnvelope {
  return {
    id: `msg_${uuid()}`,
    accountId: account.id,
    channel: 'mattermost',
    direction: 'inbound',
    timestamp: new Date(post.create_at),
    conversationId: post.channel_id,
    sender: {
      id: post.user_id,
    },
    recipient: {
      id: account.id,
    },
    content: mapPostToContent(post),
    channelDetails: mapMattermostChannelDetails(post),
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
