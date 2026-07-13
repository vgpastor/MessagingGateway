import { describe, it, expect } from 'vitest';
import { mapPostToContent, buildMattermostEnvelope, mapMattermostChannelDetails } from '../../../src/integrations/mattermost/mattermost-content.mapper.js';
import type { MattermostPost } from '../../../src/integrations/mattermost/mattermost-channel.types.js';
import type { ChannelAccount } from '../../../src/core/accounts/channel-account.js';

const testAccount: ChannelAccount = {
  id: 'mm-test',
  alias: 'Mattermost Test',
  channel: 'mattermost',
  provider: 'mattermost',
  status: 'active',
  identity: { channel: 'mattermost', botId: 'bot-001', botUsername: 'testbot' },
  credentialsRef: 'MM_TEST',
  providerConfig: { serverUrl: 'https://mm.example.com' },
  metadata: {
    owner: 'test-team',
    environment: 'production',
    tags: ['mattermost', 'test'],
  },
};

function makePost(overrides?: Partial<MattermostPost>): MattermostPost {
  return {
    id: 'post-001',
    channel_id: 'ch-001',
    user_id: 'user-001',
    message: 'Hello world',
    create_at: 1709100600000,
    update_at: 0,
    edit_at: 0,
    delete_at: 0,
    ...overrides,
  };
}

describe('mapPostToContent', () => {
  it('should map text-only post', () => {
    const content = mapPostToContent(makePost());
    expect(content.type).toBe('text');
    if (content.type === 'text') {
      expect(content.body).toBe('Hello world');
    }
  });

  it('should map post with no message and no files as text', () => {
    const content = mapPostToContent(makePost({ message: '', file_ids: [] }));
    expect(content.type).toBe('text');
  });

  it('should map single image file', () => {
    const post = makePost({
      message: 'Check this',
      file_ids: ['file-001'],
      metadata: {
        files: [{ id: 'file-001', name: 'photo.jpg', extension: 'jpg', size: 102400, mime_type: 'image/jpeg' }],
      },
    });
    const content = mapPostToContent(post);
    expect(content.type).toBe('image');
    if (content.type === 'image') {
      expect(content.media.id).toBe('file-001');
      expect(content.media.mimeType).toBe('image/jpeg');
      expect(content.media.size).toBe(102400);
      expect(content.caption).toBe('Check this');
    }
  });

  it('should map single audio file', () => {
    const post = makePost({
      file_ids: ['file-002'],
      metadata: {
        files: [{ id: 'file-002', name: 'voice.ogg', extension: 'ogg', size: 50000, mime_type: 'audio/ogg' }],
      },
    });
    const content = mapPostToContent(post);
    expect(content.type).toBe('audio');
    if (content.type === 'audio') {
      expect(content.media.id).toBe('file-002');
      expect(content.media.mimeType).toBe('audio/ogg');
    }
  });

  it('should map single video file', () => {
    const post = makePost({
      message: 'Video time',
      file_ids: ['file-003'],
      metadata: {
        files: [{ id: 'file-003', name: 'clip.mp4', extension: 'mp4', size: 5000000, mime_type: 'video/mp4' }],
      },
    });
    const content = mapPostToContent(post);
    expect(content.type).toBe('video');
    if (content.type === 'video') {
      expect(content.media.mimeType).toBe('video/mp4');
      expect(content.caption).toBe('Video time');
    }
  });

  it('should map single document file', () => {
    const post = makePost({
      message: 'Report',
      file_ids: ['file-004'],
      metadata: {
        files: [{ id: 'file-004', name: 'report.pdf', extension: 'pdf', size: 1024000, mime_type: 'application/pdf' }],
      },
    });
    const content = mapPostToContent(post);
    expect(content.type).toBe('document');
    if (content.type === 'document') {
      expect(content.fileName).toBe('report.pdf');
      expect(content.media.mimeType).toBe('application/pdf');
    }
  });

  it('should fall back to text for multiple files', () => {
    const post = makePost({
      message: 'Multiple attachments',
      file_ids: ['file-001', 'file-002'],
    });
    const content = mapPostToContent(post);
    expect(content.type).toBe('text');
    if (content.type === 'text') {
      expect(content.body).toBe('Multiple attachments');
    }
  });

  it('should use text body when file_ids exist but no metadata', () => {
    const post = makePost({
      message: 'Some files attached',
      file_ids: ['file-001'],
    });
    const content = mapPostToContent(post);
    // No metadata → falls through to text with file IDs
    expect(content.type).toBe('text');
  });
});

describe('mapMattermostChannelDetails', () => {
  it('should map channel details', () => {
    const post = makePost({ root_id: 'root-1', parent_id: 'parent-1', reply_count: 3 });
    const details = mapMattermostChannelDetails(post);
    expect(details.platform).toBe('mattermost');
    expect(details.postId).toBe('post-001');
    expect(details.channelId).toBe('ch-001');
    expect(details.rootId).toBe('root-1');
    expect(details.parentId).toBe('parent-1');
    expect(details.replyCount).toBe(3);
  });
});

describe('buildMattermostEnvelope', () => {
  it('should build a complete unified envelope from a post', () => {
    const post = makePost({ create_at: 1709100600000 });
    const envelope = buildMattermostEnvelope(post, testAccount);

    expect(envelope.id).toMatch(/^msg_/);
    expect(envelope.accountId).toBe('mm-test');
    expect(envelope.channel).toBe('mattermost');
    expect(envelope.direction).toBe('inbound');
    expect(envelope.timestamp).toEqual(new Date(1709100600000));
    expect(envelope.conversationId).toBe('ch-001');
    expect(envelope.sender.id).toBe('user-001');
    expect(envelope.recipient.id).toBe('mm-test');
    expect(envelope.content.type).toBe('text');
    if (envelope.content.type === 'text') {
      expect(envelope.content.body).toBe('Hello world');
    }
    expect(envelope.channelDetails?.platform).toBe('mattermost');
    expect(envelope.channelDetails?.postId).toBe('post-001');
    expect(envelope.gateway.adapterId).toBe('mattermost');
    expect(envelope.gateway.account.id).toBe('mm-test');
    expect(envelope.gateway.account.owner).toBe('test-team');
    expect(envelope.gateway.account.tags).toEqual(['mattermost', 'test']);
  });

  it('should use create_at as timestamp', () => {
    const ts = 1700000000000;
    const post = makePost({ create_at: ts });
    const envelope = buildMattermostEnvelope(post, testAccount);
    expect(envelope.timestamp).toEqual(new Date(ts));
  });
});
