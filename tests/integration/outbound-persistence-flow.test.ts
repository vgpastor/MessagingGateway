/**
 * Outside-in test: Outbound message persistence flow
 *
 * Tests the complete use case:
 *   API send request → MessageRouter → EventBus(MESSAGE_OUTBOUND) → PersistenceSubscriber → MessageStore
 *
 * Uses real EventBus and a spy MessageStore to verify the full chain
 * without depending on external services (WhatsApp, SQLite, Postgres).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageRouterService } from '../../src/core/routing/message-router.service.js';
import { EventBus } from '../../src/core/event-bus.js';
import { Events } from '../../src/core/events.js';
import { subscribePersistence } from '../../src/persistence/persistence-subscriber.js';
import type { ChannelAccountRepository } from '../../src/core/accounts/channel-account.repository.js';
import type { MessagingAdapterFactory } from '../../src/core/messaging/ports/messaging-adapter.port.js';
import type { MessagingPort } from '../../src/core/messaging/messaging.port.js';
import type { ChannelAccount } from '../../src/core/accounts/channel-account.js';
import type { MessageStorePort } from '../../src/core/persistence/message-store.port.js';
import type { UnifiedEnvelope } from '../../src/core/messaging/unified-envelope.js';

// ── Fixtures ──────────────────────────────────────────────────────

const whatsappAccount: ChannelAccount = {
  id: 'wa-test',
  alias: 'Test WhatsApp',
  channel: 'whatsapp',
  provider: 'baileys',
  status: 'active',
  identity: { channel: 'whatsapp', phoneNumber: '+34600000001' },
  credentialsRef: 'TEST_CRED',
  providerConfig: {},
  metadata: { owner: 'test-org', environment: 'test', tags: ['whatsapp', 'test'] },
};

const telegramAccount: ChannelAccount = {
  id: 'tg-test',
  alias: 'Test Telegram',
  channel: 'telegram',
  provider: 'telegram-bot-api',
  status: 'active',
  identity: { channel: 'telegram', botId: 'bot123', botUsername: 'test_bot' },
  credentialsRef: 'TG_CRED',
  providerConfig: {},
  metadata: { owner: 'test-org', environment: 'test', tags: ['telegram'] },
};

function createMockStore(): MessageStorePort & { saved: UnifiedEnvelope[] } {
  const saved: UnifiedEnvelope[] = [];
  return {
    saved,
    save: vi.fn(async (envelope: UnifiedEnvelope) => { saved.push(envelope); }),
    query: vi.fn(),
    findById: vi.fn(),
    count: vi.fn(),
    init: vi.fn(),
    close: vi.fn(),
  };
}

// ── Tests ─────────────────────────────────────────────────────────

describe('Outbound message persistence flow', () => {
  let eventBus: EventBus;
  let store: ReturnType<typeof createMockStore>;
  let mockAdapter: MessagingPort;
  let mockRepository: ChannelAccountRepository;
  let mockAdapterFactory: MessagingAdapterFactory;

  beforeEach(() => {
    vi.useFakeTimers();
    eventBus = new EventBus();
    store = createMockStore();
    subscribePersistence(eventBus, store);

    mockAdapter = {
      sendMessage: vi.fn().mockResolvedValue({
        messageId: 'wamid-001',
        status: 'sent',
        timestamp: new Date('2026-04-05T10:00:00Z'),
        providerMessageId: 'wamid-001',
      }),
      getMessageStatus: vi.fn(),
      downloadMedia: vi.fn(),
      markAsRead: vi.fn(),
    };

    mockRepository = {
      findById: vi.fn(),
      findAll: vi.fn(),
      findByChannel: vi.fn(),
      findByOwner: vi.fn(),
      findByTags: vi.fn(),
      findByRoutingRules: vi.fn(),
    };

    mockAdapterFactory = {
      create: vi.fn().mockReturnValue(mockAdapter),
      has: vi.fn().mockReturnValue(true),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should persist outbound text message after successful send', async () => {
    vi.mocked(mockRepository.findById).mockResolvedValue(whatsappAccount);
    const router = new MessageRouterService(mockRepository, mockAdapterFactory, eventBus);

    const result = await router.send({
      fromAccountId: 'wa-test',
      to: '+34600000099',
      content: { type: 'text', body: 'Hello from gateway' },
    });

    // Wait for async event propagation
    await vi.advanceTimersByTimeAsync(0);

    expect(result.status).toBe('sent');
    expect(store.save).toHaveBeenCalledTimes(1);

    const saved = store.saved[0];
    expect(saved.direction).toBe('outbound');
    expect(saved.accountId).toBe('wa-test');
    expect(saved.channel).toBe('whatsapp');
    expect(saved.conversationId).toBe('+34600000099');
    expect(saved.sender.id).toBe('+34600000001');
    expect(saved.sender.displayName).toBe('Test WhatsApp');
    expect(saved.recipient.id).toBe('+34600000099');
    expect(saved.content).toEqual({ type: 'text', body: 'Hello from gateway' });
    expect(saved.gateway.adapterId).toBe('baileys');
    expect(saved.gateway.account.owner).toBe('test-org');
  });

  it('should use remoteJid as conversationId when provider returns it', async () => {
    vi.mocked(mockAdapter.sendMessage).mockResolvedValue({
      messageId: 'wamid-002',
      status: 'sent',
      timestamp: new Date('2026-04-05T10:01:00Z'),
      providerMessageId: 'wamid-002',
      remoteJid: '34600000099@s.whatsapp.net',
    });
    vi.mocked(mockRepository.findById).mockResolvedValue(whatsappAccount);
    const router = new MessageRouterService(mockRepository, mockAdapterFactory, eventBus);

    await router.send({
      fromAccountId: 'wa-test',
      to: '+34600000099',
      content: { type: 'text', body: 'Test remoteJid' },
    });

    await vi.advanceTimersByTimeAsync(0);

    const saved = store.saved[0];
    expect(saved.conversationId).toBe('34600000099@s.whatsapp.net');
    expect(saved.recipient.id).toBe('+34600000099');
  });

  it('should persist outbound image message with media metadata', async () => {
    vi.mocked(mockRepository.findById).mockResolvedValue(whatsappAccount);
    const router = new MessageRouterService(mockRepository, mockAdapterFactory, eventBus);

    await router.send({
      fromAccountId: 'wa-test',
      to: '+34600000099',
      content: {
        type: 'image',
        mediaUrl: 'https://example.com/photo.jpg',
        mimeType: 'image/jpeg',
        caption: 'A photo',
      },
    });

    await vi.advanceTimersByTimeAsync(0);

    const saved = store.saved[0];
    expect(saved.content.type).toBe('image');
    expect(saved.content).toEqual({
      type: 'image',
      media: { mimeType: 'image/jpeg', url: 'https://example.com/photo.jpg' },
      caption: 'A photo',
    });
  });

  it('should NOT persist when send fails', async () => {
    vi.mocked(mockAdapter.sendMessage).mockResolvedValue({
      messageId: '',
      status: 'failed',
      timestamp: new Date(),
      error: 'Not connected',
    });
    vi.mocked(mockRepository.findById).mockResolvedValue(whatsappAccount);
    const router = new MessageRouterService(mockRepository, mockAdapterFactory, eventBus);

    await router.send({
      fromAccountId: 'wa-test',
      to: '+34600000099',
      content: { type: 'text', body: 'This will fail' },
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(store.save).not.toHaveBeenCalled();
  });

  it('should NOT persist when eventBus is not provided (backwards compatibility)', async () => {
    vi.mocked(mockRepository.findById).mockResolvedValue(whatsappAccount);
    const routerNoEvents = new MessageRouterService(mockRepository, mockAdapterFactory);

    await routerNoEvents.send({
      fromAccountId: 'wa-test',
      to: '+34600000099',
      content: { type: 'text', body: 'No persistence' },
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(store.save).not.toHaveBeenCalled();
  });

  it('should not break send flow when store.save throws', async () => {
    vi.mocked(store.save).mockRejectedValue(new Error('DB connection lost'));
    vi.mocked(mockRepository.findById).mockResolvedValue(whatsappAccount);
    const router = new MessageRouterService(mockRepository, mockAdapterFactory, eventBus);

    const result = await router.send({
      fromAccountId: 'wa-test',
      to: '+34600000099',
      content: { type: 'text', body: 'Store will fail' },
    });

    await vi.advanceTimersByTimeAsync(0);

    // Send succeeds even though persistence failed
    expect(result.status).toBe('sent');
    expect(store.save).toHaveBeenCalledTimes(1);
  });

  it('should handle non-whatsapp channels (Telegram sender uses botId)', async () => {
    vi.mocked(mockRepository.findById).mockResolvedValue(telegramAccount);
    const router = new MessageRouterService(mockRepository, mockAdapterFactory, eventBus);

    await router.send({
      fromAccountId: 'tg-test',
      to: '987654321',
      content: { type: 'text', body: 'Hello from Telegram' },
    });

    await vi.advanceTimersByTimeAsync(0);

    const saved = store.saved[0];
    expect(saved.direction).toBe('outbound');
    expect(saved.channel).toBe('telegram');
    // Telegram identity doesn't have phoneNumber, falls back to account.id
    expect(saved.sender.id).toBe('tg-test');
    expect(saved.conversationId).toBe('987654321');
  });
});

describe('Inbound message persistence flow', () => {
  let eventBus: EventBus;
  let store: ReturnType<typeof createMockStore>;

  beforeEach(() => {
    eventBus = new EventBus();
    store = createMockStore();
    subscribePersistence(eventBus, store);
  });

  it('should persist inbound message emitted through EventBus', async () => {
    const envelope: UnifiedEnvelope = {
      id: 'msg_test-inbound-001',
      accountId: 'wa-test',
      channel: 'whatsapp',
      direction: 'inbound',
      timestamp: new Date('2026-04-05T10:30:00Z'),
      conversationId: '34600000099@s.whatsapp.net',
      sender: { id: '34600000099@s.whatsapp.net', displayName: 'Customer' },
      recipient: { id: '+34600000001' },
      content: { type: 'text', body: 'Hi, I need help' },
      gateway: {
        receivedAt: new Date('2026-04-05T10:30:00Z'),
        adapterId: 'baileys',
        account: { id: 'wa-test', alias: 'Test WA', owner: 'test-org', tags: ['whatsapp'] },
      },
    };

    await eventBus.emit({
      id: 'evt-001',
      type: Events.MESSAGE_INBOUND,
      timestamp: new Date(),
      source: 'baileys',
      data: { envelope },
    });

    expect(store.save).toHaveBeenCalledTimes(1);
    expect(store.saved[0].id).toBe('msg_test-inbound-001');
    expect(store.saved[0].direction).toBe('inbound');
    expect(store.saved[0].content.body).toBe('Hi, I need help');
  });

  it('should persist both inbound and outbound in a bidirectional conversation', async () => {
    const inboundEnvelope: UnifiedEnvelope = {
      id: 'msg_in-001',
      accountId: 'wa-test',
      channel: 'whatsapp',
      direction: 'inbound',
      timestamp: new Date('2026-04-05T10:00:00Z'),
      conversationId: '34600000099@s.whatsapp.net',
      sender: { id: '34600000099@s.whatsapp.net', displayName: 'Customer' },
      recipient: { id: '+34600000001' },
      content: { type: 'text', body: 'Question from customer' },
      gateway: {
        receivedAt: new Date(),
        adapterId: 'baileys',
        account: { id: 'wa-test', alias: 'Test WA', owner: 'test-org', tags: ['whatsapp'] },
      },
    };

    const outboundEnvelope: UnifiedEnvelope = {
      id: 'msg_out-001',
      accountId: 'wa-test',
      channel: 'whatsapp',
      direction: 'outbound',
      timestamp: new Date('2026-04-05T10:01:00Z'),
      conversationId: '34600000099@s.whatsapp.net',
      sender: { id: '+34600000001', displayName: 'Test WA' },
      recipient: { id: '+34600000099' },
      content: { type: 'text', body: 'Reply from agent' },
      gateway: {
        receivedAt: new Date(),
        adapterId: 'baileys',
        account: { id: 'wa-test', alias: 'Test WA', owner: 'test-org', tags: ['whatsapp'] },
      },
    };

    await eventBus.emit({
      id: 'evt-in', type: Events.MESSAGE_INBOUND,
      timestamp: new Date(), source: 'baileys',
      data: { envelope: inboundEnvelope },
    });
    await eventBus.emit({
      id: 'evt-out', type: Events.MESSAGE_OUTBOUND,
      timestamp: new Date(), source: 'router',
      data: { envelope: outboundEnvelope },
    });

    expect(store.save).toHaveBeenCalledTimes(2);
    expect(store.saved[0].direction).toBe('inbound');
    expect(store.saved[1].direction).toBe('outbound');
    expect(store.saved[0].conversationId).toBe(store.saved[1].conversationId);
  });
});
