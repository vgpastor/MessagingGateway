import { describe, it, expect, vi } from 'vitest';
import { ConversationContextService } from '../../../src/core/persistence/conversation-context.service.js';
import type { ConversationHistoryPort, RawConversationHistory, ConversationHistoryOptions } from '../../../src/core/persistence/message-store.port.js';
import type { UnifiedEnvelope } from '../../../src/core/messaging/unified-envelope.js';

// ── Fixtures ────────────────────────────────────────────────────

function makeEnvelope(overrides: Partial<UnifiedEnvelope> & Pick<UnifiedEnvelope, 'id' | 'direction' | 'content'>): UnifiedEnvelope {
  return {
    accountId: 'acc-1',
    channel: 'whatsapp',
    timestamp: new Date('2026-04-05T10:00:00.000Z'),
    conversationId: 'conv-001',
    sender: { id: 'user-1', displayName: 'Alice' },
    recipient: { id: 'user-2' },
    gateway: {
      receivedAt: new Date('2026-04-05T10:00:00.000Z'),
      adapterId: 'baileys',
      account: { id: 'acc-1', alias: 'Test', owner: 'test', tags: [] },
    },
    ...overrides,
  };
}

const envelopes: UnifiedEnvelope[] = [
  makeEnvelope({
    id: 'msg-1',
    direction: 'inbound',
    content: { type: 'text', body: 'Hello from Alice' },
    sender: { id: 'user-1', displayName: 'Alice' },
  }),
  makeEnvelope({
    id: 'msg-2',
    direction: 'outbound',
    content: { type: 'image', media: { mimeType: 'image/jpeg' }, caption: 'Photo reply' },
    sender: { id: 'user-2', displayName: 'Bob' },
  }),
  makeEnvelope({
    id: 'msg-3',
    direction: 'inbound',
    content: { type: 'text', body: 'Thanks Bob!' },
    sender: { id: 'user-1', displayName: 'Alice' },
  }),
];

const mockHistory: RawConversationHistory = {
  conversationId: 'conv-001',
  groupName: 'Test Group',
  participantCount: 2,
  participants: [
    { id: 'user-1', name: 'Alice', messageCount: 3 },
    { id: 'user-2', name: 'Bob', messageCount: 2 },
  ],
  totalMessages: 5,
  envelopes,
};

function createMockPort(): ConversationHistoryPort & { getConversationHistory: ReturnType<typeof vi.fn> } {
  return {
    getConversationHistory: vi.fn().mockResolvedValue(mockHistory),
  };
}

// ── Tests ───────────────────────────────────────────────────────

describe('ConversationContextService', () => {
  it('default format (openai): messages have role field, inbound → user, outbound → assistant', async () => {
    const port = createMockPort();
    const service = new ConversationContextService(port);

    const result = await service.getContext('conv-001');

    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]!.role).toBe('user');
    expect(result.messages[1]!.role).toBe('assistant');
    expect(result.messages[2]!.role).toBe('user');
  });

  it('format: "raw" → result has envelopes array', async () => {
    const port = createMockPort();
    const service = new ConversationContextService(port);

    const result = await service.getContext('conv-001', { format: 'raw' });

    expect(result.envelopes).toBeDefined();
    expect(result.envelopes).toHaveLength(3);
  });

  it('format: "openai" → result does NOT have envelopes array', async () => {
    const port = createMockPort();
    const service = new ConversationContextService(port);

    const result = await service.getContext('conv-001', { format: 'openai' });

    expect(result.envelopes).toBeUndefined();
  });

  it('includeMedia: true (default) → image content shows [Image: caption]', async () => {
    const port = createMockPort();
    const service = new ConversationContextService(port);

    const result = await service.getContext('conv-001');

    // msg-2 is the image with caption
    expect(result.messages[1]!.content).toBe('[Image: Photo reply]');
  });

  it('includeMedia: false → image content shows caption only', async () => {
    const port = createMockPort();
    const service = new ConversationContextService(port);

    const result = await service.getContext('conv-001', { includeMedia: false });

    expect(result.messages[1]!.content).toBe('Photo reply');
  });

  it('options passthrough: limit, since, accountId are forwarded to the history port', async () => {
    const port = createMockPort();
    const service = new ConversationContextService(port);
    const since = new Date('2026-04-01T00:00:00Z');

    await service.getContext('conv-001', {
      limit: 10,
      since,
      accountId: 'acc-42',
    });

    expect(port.getConversationHistory).toHaveBeenCalledWith('conv-001', {
      limit: 10,
      since,
      accountId: 'acc-42',
    });
  });

  it('direction mapping: inbound → user, outbound → assistant', async () => {
    const port = createMockPort();
    const service = new ConversationContextService(port);

    const result = await service.getContext('conv-001');

    for (const msg of result.messages) {
      expect(['user', 'assistant', 'system']).toContain(msg.role);
    }
    // Verify specific mappings
    expect(result.messages[0]!.role).toBe('user');     // inbound
    expect(result.messages[1]!.role).toBe('assistant'); // outbound
  });

  it('message fields: each message has role, name, content, timestamp, type, id', async () => {
    const port = createMockPort();
    const service = new ConversationContextService(port);

    const result = await service.getContext('conv-001');

    for (const msg of result.messages) {
      expect(msg).toHaveProperty('role');
      expect(msg).toHaveProperty('name');
      expect(msg).toHaveProperty('content');
      expect(msg).toHaveProperty('timestamp');
      expect(msg).toHaveProperty('type');
      expect(msg).toHaveProperty('id');
    }

    // Spot check the first message
    const first = result.messages[0]!;
    expect(first.id).toBe('msg-1');
    expect(first.name).toBe('Alice');
    expect(first.content).toBe('Hello from Alice');
    expect(first.type).toBe('text');
  });

  it('conversation metadata is passed through', async () => {
    const port = createMockPort();
    const service = new ConversationContextService(port);

    const result = await service.getContext('conv-001');

    expect(result.conversationId).toBe('conv-001');
    expect(result.groupName).toBe('Test Group');
    expect(result.participantCount).toBe(2);
    expect(result.participants).toHaveLength(2);
    expect(result.totalMessages).toBe(5);
  });
});
