import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebhookForwarder } from '../../../src/connections/webhooks/webhook-forwarder.js';
import type { WebhookConfig, WebhookConfigInput } from '../../../src/core/webhooks/webhook-config.js';
import type { WebhookConfigRepository } from '../../../src/core/webhooks/webhook-config.repository.js';
import type { UnifiedEnvelope } from '../../../src/core/messaging/unified-envelope.js';

function makeRepo(config?: WebhookConfig): WebhookConfigRepository {
  return {
    findByAccountId: vi.fn().mockResolvedValue(config),
    findAll: vi.fn().mockResolvedValue(config ? [config] : []),
    upsert: vi.fn(),
    remove: vi.fn(),
  };
}

function makeEnvelope(accountId = 'wa-acme'): UnifiedEnvelope {
  return {
    id: 'msg_123',
    accountId,
    channel: 'whatsapp',
    direction: 'inbound',
    timestamp: new Date(),
    conversationId: '34699000001@c.us',
    sender: { id: '34699000001@c.us', displayName: 'Test' },
    recipient: { id: '+34600000001' },
    content: { type: 'text', body: 'Hello' },
    channelDetails: { platform: 'whatsapp', messageId: 'wamid.test123' },
    gateway: {
      receivedAt: new Date(),
      adapterId: 'wwebjs-api',
      account: { id: accountId, alias: 'Test', owner: 'test', tags: [] },
    },
  };
}

describe('WebhookForwarder', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok', { status: 200 })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should forward to per-account webhook when configured', async () => {
    const repo = makeRepo({
      accountId: 'wa-acme',
      url: 'https://account-hook.example.com',
      secret: 'acc-secret',
      events: ['*'],
      enabled: true,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    });
    const forwarder = new WebhookForwarder(repo, 'https://global.example.com', 'global-secret');

    await forwarder.forward(makeEnvelope());

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      'https://account-hook.example.com',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-UMG-Signature': expect.stringContaining('sha256='),
        }),
      }),
    );
  });

  it('should fall back to global webhook when no per-account config', async () => {
    const repo = makeRepo(undefined);
    const forwarder = new WebhookForwarder(repo, 'https://global.example.com', undefined);

    await forwarder.forward(makeEnvelope());

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      'https://global.example.com',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('should fall back to global when per-account is disabled', async () => {
    const repo = makeRepo({
      accountId: 'wa-acme',
      url: 'https://disabled-hook.example.com',
      events: ['*'],
      enabled: false,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    });
    const forwarder = new WebhookForwarder(repo, 'https://global.example.com', undefined);

    await forwarder.forward(makeEnvelope());

    expect(fetch).toHaveBeenCalledWith(
      'https://global.example.com',
      expect.anything(),
    );
  });

  it('should not forward when event type does not match', async () => {
    const repo = makeRepo({
      accountId: 'wa-acme',
      url: 'https://hook.example.com',
      events: ['message.status'], // only status events
      enabled: true,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    });
    const forwarder = new WebhookForwarder(repo, 'https://global.example.com', undefined);

    await forwarder.forward(makeEnvelope(), 'message.inbound');

    // Should fall back to global since event doesn't match
    expect(fetch).toHaveBeenCalledWith(
      'https://global.example.com',
      expect.anything(),
    );
  });

  it('should not forward at all when no config and no global URL', async () => {
    const repo = makeRepo(undefined);
    const forwarder = new WebhookForwarder(repo, undefined, undefined);

    await forwarder.forward(makeEnvelope());

    expect(fetch).not.toHaveBeenCalled();
  });

  it('should include correct headers', async () => {
    const repo = makeRepo({
      accountId: 'wa-acme',
      url: 'https://hook.example.com',
      events: ['*'],
      enabled: true,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    });
    const forwarder = new WebhookForwarder(repo, undefined, undefined);

    await forwarder.forward(makeEnvelope(), 'message.inbound');

    expect(fetch).toHaveBeenCalledWith(
      'https://hook.example.com',
      expect.objectContaining({
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-UMG-Event': 'message.inbound',
          'X-UMG-Channel': 'whatsapp',
          'X-UMG-Account': 'wa-acme',
        }),
      }),
    );
  });

  it('should not throw when fetch fails', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('Network error'));
    const repo = makeRepo({
      accountId: 'wa-acme',
      url: 'https://hook.example.com',
      events: ['*'],
      enabled: true,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    });
    const forwarder = new WebhookForwarder(repo, undefined, undefined);

    // Should not throw
    await expect(forwarder.forward(makeEnvelope())).resolves.toBeUndefined();
  });
});
