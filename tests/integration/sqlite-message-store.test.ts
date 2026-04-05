/**
 * Outside-in test: SQLite message store — complete use cases
 *
 * Tests the full persistence lifecycle with a real SQLite database:
 *   init (migrations) → save → query → search → conversation context → stats
 *
 * Each test uses a fresh temporary database file, cleaned up after.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rm } from 'node:fs/promises';
import { SqliteMessageStore } from '../../src/persistence/sqlite-message-store.js';
import type { UnifiedEnvelope } from '../../src/core/messaging/unified-envelope.js';

// ── Helpers ───────────────────────────────────────────────────────

let tmpDbPath: string;
let store: SqliteMessageStore;

function makeEnvelope(overrides: Partial<UnifiedEnvelope> & { id: string }): UnifiedEnvelope {
  return {
    accountId: 'wa-test',
    channel: 'whatsapp',
    direction: 'inbound',
    timestamp: new Date('2026-04-05T10:00:00Z'),
    conversationId: '34600000099@s.whatsapp.net',
    sender: { id: '34600000099@s.whatsapp.net', displayName: 'Customer' },
    recipient: { id: '+34600000001' },
    content: { type: 'text', body: 'Default message body' },
    gateway: {
      receivedAt: new Date('2026-04-05T10:00:00Z'),
      adapterId: 'baileys',
      account: { id: 'wa-test', alias: 'Test WA', owner: 'test-org', tags: ['whatsapp'] },
    },
    ...overrides,
  };
}

// ── Lifecycle ─────────────────────────────────────────────────────

beforeEach(async () => {
  tmpDbPath = join(tmpdir(), `mg-store-test-${Date.now()}.db`);
  store = new SqliteMessageStore(tmpDbPath);
  await store.init();
});

afterEach(async () => {
  await store.close();
  await rm(tmpDbPath, { force: true }).catch(() => {});
  await rm(`${tmpDbPath}-wal`, { force: true }).catch(() => {});
  await rm(`${tmpDbPath}-shm`, { force: true }).catch(() => {});
});

// ── Tests ─────────────────────────────────────────────────────────

describe('SQLite MessageStore — save and retrieve', () => {
  it('should save and retrieve a message by ID', async () => {
    const envelope = makeEnvelope({ id: 'msg_find-001' });
    await store.save(envelope);

    const found = await store.findById('msg_find-001');
    expect(found).toBeDefined();
    expect(found!.id).toBe('msg_find-001');
    expect(found!.content.body).toBe('Default message body');
    expect(found!.direction).toBe('inbound');
    expect(found!.channel).toBe('whatsapp');
  });

  it('should return undefined for non-existent message ID', async () => {
    const found = await store.findById('msg_nonexistent');
    expect(found).toBeUndefined();
  });

  it('should count messages', async () => {
    await store.save(makeEnvelope({ id: 'msg_c1' }));
    await store.save(makeEnvelope({ id: 'msg_c2' }));
    await store.save(makeEnvelope({ id: 'msg_c3' }));

    const total = await store.count();
    expect(total).toBe(3);
  });
});

describe('SQLite MessageStore — query with filters', () => {
  it('should filter by direction', async () => {
    await store.save(makeEnvelope({ id: 'msg_in', direction: 'inbound' }));
    await store.save(makeEnvelope({
      id: 'msg_out',
      direction: 'outbound',
      sender: { id: '+34600000001', displayName: 'Agent' },
      recipient: { id: '+34600000099' },
    }));

    const inbound = await store.query({ direction: 'inbound', limit: 10, offset: 0 });
    expect(inbound.messages).toHaveLength(1);
    expect(inbound.messages[0].direction).toBe('inbound');

    const outbound = await store.query({ direction: 'outbound', limit: 10, offset: 0 });
    expect(outbound.messages).toHaveLength(1);
    expect(outbound.messages[0].direction).toBe('outbound');
  });

  it('should filter by accountId', async () => {
    await store.save(makeEnvelope({ id: 'msg_a1', accountId: 'wa-test' }));
    await store.save(makeEnvelope({ id: 'msg_a2', accountId: 'wa-other' }));

    const result = await store.query({ accountId: 'wa-test', limit: 10, offset: 0 });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].accountId).toBe('wa-test');
  });

  it('should filter by conversationId', async () => {
    await store.save(makeEnvelope({ id: 'msg_cv1', conversationId: 'conv-A' }));
    await store.save(makeEnvelope({ id: 'msg_cv2', conversationId: 'conv-B' }));

    const result = await store.query({ conversationId: 'conv-A', limit: 10, offset: 0 });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].conversationId).toBe('conv-A');
  });

  it('should support pagination with limit and offset', async () => {
    for (let i = 0; i < 5; i++) {
      await store.save(makeEnvelope({
        id: `msg_page-${i}`,
        timestamp: new Date(`2026-04-05T10:0${i}:00Z`),
      }));
    }

    const page1 = await store.query({ limit: 2, offset: 0 });
    expect(page1.messages).toHaveLength(2);
    expect(page1.total).toBe(5);

    const page2 = await store.query({ limit: 2, offset: 2 });
    expect(page2.messages).toHaveLength(2);

    const page3 = await store.query({ limit: 2, offset: 4 });
    expect(page3.messages).toHaveLength(1);
  });

  it('should return messages ordered by timestamp descending', async () => {
    await store.save(makeEnvelope({ id: 'msg_old', timestamp: new Date('2026-04-05T08:00:00Z') }));
    await store.save(makeEnvelope({ id: 'msg_new', timestamp: new Date('2026-04-05T12:00:00Z') }));
    await store.save(makeEnvelope({ id: 'msg_mid', timestamp: new Date('2026-04-05T10:00:00Z') }));

    const result = await store.query({ limit: 10, offset: 0 });
    expect(result.messages[0].id).toBe('msg_new');
    expect(result.messages[1].id).toBe('msg_mid');
    expect(result.messages[2].id).toBe('msg_old');
  });
});

describe('SQLite MessageStore — full-text search', () => {
  it('should find messages by text content', async () => {
    await store.save(makeEnvelope({ id: 'msg_s1', content: { type: 'text', body: 'I need help with my order' } }));
    await store.save(makeEnvelope({ id: 'msg_s2', content: { type: 'text', body: 'Hello, how are you?' } }));
    await store.save(makeEnvelope({ id: 'msg_s3', content: { type: 'text', body: 'My order number is 12345' } }));

    const result = await store.search('order');
    expect(result.messages.length).toBeGreaterThanOrEqual(2);
    const bodies = result.messages.map((m) => m.content.body);
    expect(bodies).toContain('I need help with my order');
    expect(bodies).toContain('My order number is 12345');
  });

  it('should return empty results for unmatched search', async () => {
    await store.save(makeEnvelope({ id: 'msg_nomatch', content: { type: 'text', body: 'Hello world' } }));

    const result = await store.search('xyznonexistent');
    expect(result.messages).toHaveLength(0);
  });
});

describe('SQLite MessageStore — conversation context (bidirectional)', () => {
  it('should return bidirectional conversation with correct roles', async () => {
    const convId = '34600000099@s.whatsapp.net';

    // Inbound from customer
    await store.save(makeEnvelope({
      id: 'msg_ctx-in1',
      direction: 'inbound',
      conversationId: convId,
      timestamp: new Date('2026-04-05T10:00:00Z'),
      sender: { id: convId, displayName: 'Customer' },
      content: { type: 'text', body: 'Hi, I have a question' },
    }));

    // Outbound reply from agent
    await store.save(makeEnvelope({
      id: 'msg_ctx-out1',
      direction: 'outbound',
      conversationId: convId,
      timestamp: new Date('2026-04-05T10:01:00Z'),
      sender: { id: '+34600000001', displayName: 'Agent' },
      recipient: { id: '+34600000099' },
      content: { type: 'text', body: 'Sure, how can I help?' },
    }));

    // Another inbound
    await store.save(makeEnvelope({
      id: 'msg_ctx-in2',
      direction: 'inbound',
      conversationId: convId,
      timestamp: new Date('2026-04-05T10:02:00Z'),
      sender: { id: convId, displayName: 'Customer' },
      content: { type: 'text', body: 'What are your hours?' },
    }));

    const ctx = await store.getConversationContext(convId);

    expect(ctx.conversationId).toBe(convId);
    expect(ctx.totalMessages).toBe(3);
    expect(ctx.participantCount).toBe(2);

    // Messages in chronological order
    expect(ctx.messages).toHaveLength(3);
    expect(ctx.messages[0].role).toBe('user');
    expect(ctx.messages[0].content).toBe('Hi, I have a question');
    expect(ctx.messages[1].role).toBe('assistant');
    expect(ctx.messages[1].content).toBe('Sure, how can I help?');
    expect(ctx.messages[2].role).toBe('user');
    expect(ctx.messages[2].content).toBe('What are your hours?');
  });

  it('should return empty context for non-existent conversation', async () => {
    const ctx = await store.getConversationContext('nonexistent-conv');
    expect(ctx.totalMessages).toBe(0);
    expect(ctx.messages).toHaveLength(0);
    expect(ctx.participants).toHaveLength(0);
  });

  it('should list participants with message counts', async () => {
    const convId = 'group@g.us';

    await store.save(makeEnvelope({
      id: 'msg_p1', conversationId: convId, direction: 'inbound',
      sender: { id: 'user-a', displayName: 'Alice' },
      content: { type: 'text', body: 'Message from Alice' },
    }));
    await store.save(makeEnvelope({
      id: 'msg_p2', conversationId: convId, direction: 'inbound',
      sender: { id: 'user-b', displayName: 'Bob' },
      content: { type: 'text', body: 'Message from Bob' },
    }));
    await store.save(makeEnvelope({
      id: 'msg_p3', conversationId: convId, direction: 'inbound',
      sender: { id: 'user-a', displayName: 'Alice' },
      content: { type: 'text', body: 'Another from Alice' },
    }));

    const ctx = await store.getConversationContext(convId);
    expect(ctx.participantCount).toBe(2);

    const alice = ctx.participants.find((p) => p.name === 'Alice');
    const bob = ctx.participants.find((p) => p.name === 'Bob');
    expect(alice?.messageCount).toBe(2);
    expect(bob?.messageCount).toBe(1);
  });
});

describe('SQLite MessageStore — statistics', () => {
  it('should return aggregated stats by direction, channel, and content type', async () => {
    await store.save(makeEnvelope({ id: 'msg_st1', direction: 'inbound', content: { type: 'text', body: 'Hi' } }));
    await store.save(makeEnvelope({ id: 'msg_st2', direction: 'inbound', content: { type: 'image', media: { mimeType: 'image/jpeg' } } }));
    await store.save(makeEnvelope({
      id: 'msg_st3', direction: 'outbound',
      content: { type: 'text', body: 'Reply' },
      sender: { id: '+34600000001', displayName: 'Agent' },
    }));

    const stats = await store.getStats();
    expect(stats.totalMessages).toBe(3);
    expect(stats.byDirection.inbound).toBe(2);
    expect(stats.byDirection.outbound).toBe(1);
    expect(stats.byChannel.whatsapp).toBe(3);
    expect(stats.byContentType.text).toBe(2);
    expect(stats.byContentType.image).toBe(1);
  });
});

describe('SQLite MessageStore — migration idempotency', () => {
  it('should survive init() being called multiple times', async () => {
    await store.save(makeEnvelope({ id: 'msg_idem-1' }));

    // Re-init should not lose data or fail
    await store.init();

    const found = await store.findById('msg_idem-1');
    expect(found).toBeDefined();
    expect(found!.id).toBe('msg_idem-1');

    const count = await store.count();
    expect(count).toBe(1);
  });
});
