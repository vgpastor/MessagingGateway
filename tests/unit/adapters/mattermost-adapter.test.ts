import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MattermostAdapter } from '../../../src/integrations/mattermost/api-v4/mattermost.adapter.js';
import type { OutboundMessage } from '../../../src/core/messaging/outbound-message.js';
import { ProviderError } from '../../../src/core/errors.js';

const mockConfig = { serverUrl: 'https://mm.example.com' };
const mockToken = 'test-token-123';
const mockAccountId = 'mm-test-account';

function makeAdapter(): MattermostAdapter {
  return new MattermostAdapter(mockConfig, 'cred-ref', mockToken);
}

function makeTextMessage(overrides?: Partial<OutboundMessage>): OutboundMessage {
  return {
    to: 'channel-123',
    content: { type: 'text', body: 'Hello Mattermost' },
    accountId: mockAccountId,
    ...overrides,
  };
}

// Mock fetchWithTimeout
vi.mock('../../../src/integrations/shared/http.js', () => ({
  fetchWithTimeout: vi.fn(),
}));

import { fetchWithTimeout } from '../../../src/integrations/shared/http.js';
const mockFetch = vi.mocked(fetchWithTimeout);

function mockPostResponse(id = 'post-456') {
  return {
    ok: true,
    json: vi.fn().mockResolvedValue({
      id,
      channel_id: 'channel-123',
      message: 'Hello Mattermost',
      create_at: Date.now(),
    }),
  } as unknown as Response;
}

function mockGetPostResponse(id: string, rootId?: string) {
  return {
    ok: true,
    json: vi.fn().mockResolvedValue({
      id,
      channel_id: 'channel-123',
      user_id: 'user-1',
      message: 'parent',
      root_id: rootId,
    }),
  } as unknown as Response;
}

function mockErrorResponse(status = 500, body = 'Internal Server Error') {
  return {
    ok: false,
    status,
    text: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe('MattermostAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('sendMessage - text', () => {
    it('should send a text message via POST /api/v4/posts', async () => {
      mockFetch.mockResolvedValueOnce(mockPostResponse('post-001'));
      const adapter = makeAdapter();

      const result = await adapter.sendMessage(makeTextMessage());

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://mm.example.com/api/v4/posts');
      expect(init.method).toBe('POST');
      expect(init.headers).toMatchObject({ Authorization: 'Bearer test-token-123' });

      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.channel_id).toBe('channel-123');
      expect(body.message).toBe('Hello Mattermost');

      expect(result.messageId).toBe('post-001');
      expect(result.status).toBe('sent');
      expect(result.providerMessageId).toBe('post-001');
    });

    it('should include root_id when replying', async () => {
      // First call: resolveRootId → GET /posts/{replyTo}
      mockFetch.mockResolvedValueOnce(mockGetPostResponse('reply-target', 'root-789'));
      // Second call: create post
      mockFetch.mockResolvedValueOnce(mockPostResponse('post-002'));

      const adapter = makeAdapter();
      const msg = makeTextMessage({ replyToMessageId: 'reply-target' });
      const result = await adapter.sendMessage(msg);

      expect(mockFetch).toHaveBeenCalledTimes(2);

      const createBody = JSON.parse(mockFetch.mock.calls[1]![1]!.body as string) as Record<string, unknown>;
      expect(createBody.root_id).toBe('root-789');
      expect(result.messageId).toBe('post-002');
    });

    it('should use post id as root_id when reply target has no root_id', async () => {
      mockFetch.mockResolvedValueOnce(mockGetPostResponse('root-post'));
      mockFetch.mockResolvedValueOnce(mockPostResponse('post-003'));

      const adapter = makeAdapter();
      await adapter.sendMessage(makeTextMessage({ replyToMessageId: 'root-post' }));

      const createBody = JSON.parse(mockFetch.mock.calls[1]![1]!.body as string) as Record<string, unknown>;
      expect(createBody.root_id).toBe('root-post');
    });

    it('should fallback to postId as root_id on resolution failure', async () => {
      mockFetch.mockResolvedValueOnce(mockErrorResponse(404));
      mockFetch.mockResolvedValueOnce(mockPostResponse('post-004'));

      const adapter = makeAdapter();
      await adapter.sendMessage(makeTextMessage({ replyToMessageId: 'missing-post' }));

      const createBody = JSON.parse(mockFetch.mock.calls[1]![1]!.body as string) as Record<string, unknown>;
      expect(createBody.root_id).toBe('missing-post');
    });
  });

  describe('sendMessage - errors', () => {
    it('should throw ProviderError on non-2xx response', async () => {
      mockFetch.mockResolvedValueOnce(mockErrorResponse(403, 'Forbidden'));
      const adapter = makeAdapter();

      await expect(adapter.sendMessage(makeTextMessage())).rejects.toThrow(ProviderError);
    });

    it('should include HTTP status in ProviderError', async () => {
      mockFetch.mockResolvedValueOnce(mockErrorResponse(400, 'Bad Request'));
      const adapter = makeAdapter();

      try {
        await adapter.sendMessage(makeTextMessage());
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ProviderError);
        expect((err as ProviderError).statusCode).toBe(400);
      }
    });
  });

  describe('getMessageStatus', () => {
    it('should return unknown status', async () => {
      const adapter = makeAdapter();
      const status = await adapter.getMessageStatus('some-id');
      expect(status.status).toBe('unknown');
      expect(status.messageId).toBe('some-id');
    });
  });

  describe('markAsRead', () => {
    it('should be a no-op', async () => {
      const adapter = makeAdapter();
      await expect(adapter.markAsRead('some-id')).resolves.toBeUndefined();
    });
  });
});
