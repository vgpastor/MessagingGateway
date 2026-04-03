import { describe, it, expect } from 'vitest';
import { matchesFilter } from '../../../src/core/filters/envelope-filter.js';
import type { EnvelopeFilter } from '../../../src/core/filters/envelope-filter.js';

const textMessage = {
  id: 'msg_1',
  accountId: 'wa-1',
  channel: 'whatsapp',
  direction: 'inbound',
  conversationId: 'group1@g.us',
  sender: { id: 'user1@lid', displayName: 'Alice' },
  recipient: { id: '+34600000001' },
  content: { type: 'text', body: 'Hello' },
  channelDetails: { platform: 'whatsapp', isGroup: true, isBroadcast: false, messageId: 'WA123' },
};

const imageMessage = {
  ...textMessage,
  id: 'msg_2',
  content: { type: 'image', media: { mimeType: 'image/jpeg', size: 50000 }, caption: 'Photo' },
};

const stickerMessage = {
  ...textMessage,
  id: 'msg_3',
  content: { type: 'sticker', media: { mimeType: 'image/webp' } },
};

const directMessage = {
  ...textMessage,
  id: 'msg_4',
  conversationId: 'user2@s.whatsapp.net',
  channelDetails: { platform: 'whatsapp', isGroup: false, isBroadcast: false },
};

const outboundMessage = {
  ...textMessage,
  id: 'msg_5',
  direction: 'outbound',
};

const broadcastMessage = {
  ...textMessage,
  id: 'msg_6',
  conversationId: 'status@broadcast',
  channelDetails: { platform: 'whatsapp', isGroup: false, isBroadcast: true },
};

describe('matchesFilter', () => {
  describe('no filter', () => {
    it('should pass all messages when filter is undefined', () => {
      expect(matchesFilter(textMessage, undefined)).toBe(true);
    });

    it('should pass all messages when filter is empty', () => {
      expect(matchesFilter(textMessage, {})).toBe(true);
    });
  });

  describe('include filters', () => {
    it('should match by content type (single value)', () => {
      const filter: EnvelopeFilter = { include: { 'content.type': 'text' } };
      expect(matchesFilter(textMessage, filter)).toBe(true);
      expect(matchesFilter(imageMessage, filter)).toBe(false);
    });

    it('should match by content type (array — OR)', () => {
      const filter: EnvelopeFilter = { include: { 'content.type': ['text', 'image'] } };
      expect(matchesFilter(textMessage, filter)).toBe(true);
      expect(matchesFilter(imageMessage, filter)).toBe(true);
      expect(matchesFilter(stickerMessage, filter)).toBe(false);
    });

    it('should match by group flag', () => {
      const filter: EnvelopeFilter = { include: { 'channelDetails.isGroup': true } };
      expect(matchesFilter(textMessage, filter)).toBe(true);
      expect(matchesFilter(directMessage, filter)).toBe(false);
    });

    it('should match by conversationId array (multiple groups)', () => {
      const filter: EnvelopeFilter = { include: { conversationId: ['group1@g.us', 'group2@g.us'] } };
      expect(matchesFilter(textMessage, filter)).toBe(true);
      expect(matchesFilter(directMessage, filter)).toBe(false);
    });

    it('should match by sender', () => {
      const filter: EnvelopeFilter = { include: { 'sender.id': ['user1@lid', 'user3@lid'] } };
      expect(matchesFilter(textMessage, filter)).toBe(true);
    });

    it('should AND between multiple include fields', () => {
      const filter: EnvelopeFilter = {
        include: {
          'content.type': ['text', 'image'],
          'channelDetails.isGroup': true,
        },
      };
      expect(matchesFilter(textMessage, filter)).toBe(true);   // text + group ✓
      expect(matchesFilter(directMessage, filter)).toBe(false); // text but not group ✗
    });
  });

  describe('exclude filters', () => {
    it('should exclude by content type', () => {
      const filter: EnvelopeFilter = { exclude: { 'content.type': 'sticker' } };
      expect(matchesFilter(textMessage, filter)).toBe(true);
      expect(matchesFilter(stickerMessage, filter)).toBe(false);
    });

    it('should exclude by content type array', () => {
      const filter: EnvelopeFilter = { exclude: { 'content.type': ['sticker', 'reaction'] } };
      expect(matchesFilter(textMessage, filter)).toBe(true);
      expect(matchesFilter(stickerMessage, filter)).toBe(false);
    });

    it('should exclude broadcasts', () => {
      const filter: EnvelopeFilter = { exclude: { 'channelDetails.isBroadcast': true } };
      expect(matchesFilter(textMessage, filter)).toBe(true);
      expect(matchesFilter(broadcastMessage, filter)).toBe(false);
    });

    it('should reject if ANY exclude field matches (OR)', () => {
      const filter: EnvelopeFilter = {
        exclude: {
          'content.type': ['sticker'],
          'channelDetails.isBroadcast': true,
        },
      };
      expect(matchesFilter(textMessage, filter)).toBe(true);
      expect(matchesFilter(stickerMessage, filter)).toBe(false);    // sticker excluded
      expect(matchesFilter(broadcastMessage, filter)).toBe(false);  // broadcast excluded
    });
  });

  describe('fromMe filter', () => {
    it('should filter inbound only (fromMe: false)', () => {
      const filter: EnvelopeFilter = { fromMe: false };
      expect(matchesFilter(textMessage, filter)).toBe(true);
      expect(matchesFilter(outboundMessage, filter)).toBe(false);
    });

    it('should filter outbound only (fromMe: true)', () => {
      const filter: EnvelopeFilter = { fromMe: true };
      expect(matchesFilter(textMessage, filter)).toBe(false);
      expect(matchesFilter(outboundMessage, filter)).toBe(true);
    });
  });

  describe('combined filters', () => {
    it('should combine include + exclude + fromMe', () => {
      const filter: EnvelopeFilter = {
        include: { 'content.type': ['text', 'image', 'video', 'audio', 'document'] },
        exclude: { 'channelDetails.isBroadcast': true },
        fromMe: false,
      };

      expect(matchesFilter(textMessage, filter)).toBe(true);     // text, inbound, not broadcast ✓
      expect(matchesFilter(imageMessage, filter)).toBe(true);     // image, inbound, not broadcast ✓
      expect(matchesFilter(stickerMessage, filter)).toBe(false);  // sticker not in include ✗
      expect(matchesFilter(broadcastMessage, filter)).toBe(false); // broadcast excluded ✗
      expect(matchesFilter(outboundMessage, filter)).toBe(false); // fromMe=false rejects outbound ✗
    });

    it('real-world: only text from specific groups, no broadcasts', () => {
      const filter: EnvelopeFilter = {
        include: {
          conversationId: ['group1@g.us', 'group5@g.us'],
          'content.type': 'text',
        },
        exclude: { 'channelDetails.isBroadcast': true },
        fromMe: false,
      };

      expect(matchesFilter(textMessage, filter)).toBe(true);     // text, group1, inbound ✓
      expect(matchesFilter(imageMessage, filter)).toBe(false);    // image not text ✗
      expect(matchesFilter(directMessage, filter)).toBe(false);   // wrong conversationId ✗
    });
  });

  describe('edge cases', () => {
    it('should handle missing nested fields gracefully', () => {
      const filter: EnvelopeFilter = { include: { 'nonexistent.deep.field': 'value' } };
      expect(matchesFilter(textMessage, filter)).toBe(false);
    });

    it('should match boolean false values correctly', () => {
      const filter: EnvelopeFilter = { include: { 'channelDetails.isGroup': false } };
      expect(matchesFilter(directMessage, filter)).toBe(true);
      expect(matchesFilter(textMessage, filter)).toBe(false);
    });

    it('should handle empty include/exclude objects', () => {
      expect(matchesFilter(textMessage, { include: {} })).toBe(true);
      expect(matchesFilter(textMessage, { exclude: {} })).toBe(true);
    });

    it('should resolve 3-level nested paths', () => {
      const data = { gateway: { account: { owner: 'alice' } } };
      expect(matchesFilter(data, { include: { 'gateway.account.owner': 'alice' } })).toBe(true);
      expect(matchesFilter(data, { include: { 'gateway.account.owner': 'bob' } })).toBe(false);
    });

    it('should use strict equality (no string/number coercion)', () => {
      const data = { value: '123' };
      expect(matchesFilter(data, { include: { value: '123' } })).toBe(true);
      expect(matchesFilter(data, { include: { value: 123 } })).toBe(false); // strict: string !== number
    });

    it('should pass non-envelope payloads when no include filter on missing fields', () => {
      const statusPayload = { accountId: 'wa-1', status: 'delivered', messageId: 'msg-1' };
      // A filter on content.type should not crash, just not match
      expect(matchesFilter(statusPayload, { include: { 'content.type': 'text' } })).toBe(false);
      // No filter = passes
      expect(matchesFilter(statusPayload, undefined)).toBe(true);
      expect(matchesFilter(statusPayload, {})).toBe(true);
    });

    it('should return undefined for paths exceeding max depth', () => {
      const data = { a: { b: { c: { d: { e: { f: 'deep' } } } } } };
      expect(matchesFilter(data, { include: { 'a.b.c.d.e.f': 'deep' } })).toBe(false); // 6 levels > max 5
      expect(matchesFilter(data, { include: { 'a.b.c.d.e': { f: 'deep' } as any } })).toBe(false); // object value
    });
  });
});
