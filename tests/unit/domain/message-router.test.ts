import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageRouterService } from '../../../src/domain/routing/message-router.service.js';
import type { ChannelAccountRepository } from '../../../src/domain/accounts/channel-account.repository.js';
import type { AdapterFactory } from '../../../src/adapters/adapter.factory.js';
import type { ChannelAccount } from '../../../src/domain/accounts/channel-account.js';
import type { MessagingPort } from '../../../src/domain/messaging/messaging.port.js';
import { AccountNotFoundError, AccountUnavailableError } from '../../../src/domain/errors.js';

const activeAccount: ChannelAccount = {
  id: 'wa-samur',
  alias: 'SAMUR WhatsApp',
  channel: 'whatsapp',
  provider: 'wwebjs-api',
  status: 'active',
  identity: { channel: 'whatsapp', phoneNumber: '+34600000001' },
  credentialsRef: 'WWEBJS_SAMUR',
  providerConfig: { baseUrl: 'http://localhost:3001' },
  metadata: {
    owner: 'global-emergency',
    environment: 'production',
    tags: ['emergency', 'samur'],
  },
};

const suspendedAccount: ChannelAccount = {
  ...activeAccount,
  id: 'wa-suspended',
  status: 'suspended',
};

describe('MessageRouterService', () => {
  let mockRepository: ChannelAccountRepository;
  let mockAdapterFactory: AdapterFactory;
  let mockAdapter: MessagingPort;
  let router: MessageRouterService;

  beforeEach(() => {
    mockAdapter = {
      sendMessage: vi.fn().mockResolvedValue({
        messageId: 'msg-123',
        status: 'sent',
        timestamp: new Date(),
        providerMessageId: 'wamid.abc',
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
      register: vi.fn(),
      hasAdapter: vi.fn(),
    } as unknown as AdapterFactory;

    router = new MessageRouterService(mockRepository, mockAdapterFactory);
  });

  it('should send message using account ID', async () => {
    vi.mocked(mockRepository.findById).mockResolvedValue(activeAccount);

    const result = await router.send({
      fromAccountId: 'wa-samur',
      to: '+34612345678',
      content: { type: 'text', body: 'Hello' },
    });

    expect(result.status).toBe('sent');
    expect(result.messageId).toBe('msg-123');
    expect(mockRepository.findById).toHaveBeenCalledWith('wa-samur');
    expect(mockAdapterFactory.create).toHaveBeenCalledWith(activeAccount);
    expect(mockAdapter.sendMessage).toHaveBeenCalledWith({
      to: '+34612345678',
      content: { type: 'text', body: 'Hello' },
      accountId: 'wa-samur',
      replyToMessageId: undefined,
      metadata: undefined,
    });
  });

  it('should send message using routing criteria', async () => {
    vi.mocked(mockRepository.findByRoutingRules).mockResolvedValue(activeAccount);

    const result = await router.send({
      routing: { channel: 'whatsapp', owner: 'global-emergency' },
      to: '+34612345678',
      content: { type: 'text', body: 'Hello' },
    });

    expect(result.status).toBe('sent');
    expect(mockRepository.findByRoutingRules).toHaveBeenCalledWith({
      channel: 'whatsapp',
      owner: 'global-emergency',
    });
  });

  it('should throw AccountNotFoundError when account not found', async () => {
    vi.mocked(mockRepository.findById).mockResolvedValue(undefined);

    await expect(
      router.send({
        fromAccountId: 'nonexistent',
        to: '+34612345678',
        content: { type: 'text', body: 'Hello' },
      }),
    ).rejects.toThrow(AccountNotFoundError);
  });

  it('should throw AccountUnavailableError when account is not active', async () => {
    vi.mocked(mockRepository.findById).mockResolvedValue(suspendedAccount);

    await expect(
      router.send({
        fromAccountId: 'wa-suspended',
        to: '+34612345678',
        content: { type: 'text', body: 'Hello' },
      }),
    ).rejects.toThrow(AccountUnavailableError);
  });
});
