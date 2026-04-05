import { describe, it, expect } from 'vitest';
import {
  formatContentForAI,
  extractPreview,
  parseJsonColumn,
  parseJsonColumnRequired,
  toUTC,
  nowUTC,
} from '../../../src/core/persistence/message-store.utils.js';
import type { UnifiedEnvelope } from '../../../src/core/messaging/unified-envelope.js';
import type { MessageContent } from '../../../src/core/messaging/content.js';

// ── Helper ──────────────────────────────────────────────────────

function makeEnvelope(content: MessageContent): UnifiedEnvelope {
  return {
    id: 'test-id',
    accountId: 'test-account',
    channel: 'whatsapp',
    direction: 'inbound',
    timestamp: new Date('2026-04-05T10:00:00.000Z'),
    conversationId: 'conv-1',
    sender: { id: 'sender-1', displayName: 'Test User' },
    recipient: { id: 'recipient-1' },
    content,
    gateway: {
      receivedAt: new Date('2026-04-05T10:00:00.000Z'),
      adapterId: 'baileys',
      account: { id: 'test-account', alias: 'Test', owner: 'test', tags: [] },
    },
  };
}

// ── formatContentForAI ──────────────────────────────────────────

describe('formatContentForAI', () => {
  it('text → returns body directly', () => {
    const env = makeEnvelope({ type: 'text', body: 'Hello world' });
    expect(formatContentForAI(env, true)).toBe('Hello world');
    expect(formatContentForAI(env, false)).toBe('Hello world');
  });

  it('image with includeMedia=true and caption → [Image: caption]', () => {
    const env = makeEnvelope({ type: 'image', media: { mimeType: 'image/jpeg' }, caption: 'Sunset' });
    expect(formatContentForAI(env, true)).toBe('[Image: Sunset]');
  });

  it('image with includeMedia=true and no caption → [Image]', () => {
    const env = makeEnvelope({ type: 'image', media: { mimeType: 'image/jpeg' } });
    expect(formatContentForAI(env, true)).toBe('[Image]');
  });

  it('image with includeMedia=false and caption → caption only', () => {
    const env = makeEnvelope({ type: 'image', media: { mimeType: 'image/jpeg' }, caption: 'Sunset' });
    expect(formatContentForAI(env, false)).toBe('Sunset');
  });

  it('image with includeMedia=false and no caption → [Image]', () => {
    const env = makeEnvelope({ type: 'image', media: { mimeType: 'image/jpeg' } });
    expect(formatContentForAI(env, false)).toBe('[Image]');
  });

  it('video with includeMedia=true and caption → [Video: caption]', () => {
    const env = makeEnvelope({ type: 'video', media: { mimeType: 'video/mp4' }, caption: 'Clip' });
    expect(formatContentForAI(env, true)).toBe('[Video: Clip]');
  });

  it('video with includeMedia=true and no caption → [Video]', () => {
    const env = makeEnvelope({ type: 'video', media: { mimeType: 'video/mp4' } });
    expect(formatContentForAI(env, true)).toBe('[Video]');
  });

  it('video with includeMedia=false and caption → caption only', () => {
    const env = makeEnvelope({ type: 'video', media: { mimeType: 'video/mp4' }, caption: 'Clip' });
    expect(formatContentForAI(env, false)).toBe('Clip');
  });

  it('video with includeMedia=false and no caption → [Video]', () => {
    const env = makeEnvelope({ type: 'video', media: { mimeType: 'video/mp4' } });
    expect(formatContentForAI(env, false)).toBe('[Video]');
  });

  it('audio with isVoiceNote=true → [Voice note]', () => {
    const env = makeEnvelope({ type: 'audio', media: { mimeType: 'audio/ogg' }, isVoiceNote: true });
    expect(formatContentForAI(env, true)).toBe('[Voice note]');
  });

  it('audio with isVoiceNote=false → [Audio]', () => {
    const env = makeEnvelope({ type: 'audio', media: { mimeType: 'audio/ogg' }, isVoiceNote: false });
    expect(formatContentForAI(env, true)).toBe('[Audio]');
  });

  it('document with caption → [Document: filename — caption]', () => {
    const env = makeEnvelope({ type: 'document', media: { mimeType: 'application/pdf' }, fileName: 'report.pdf', caption: 'Q1 report' });
    expect(formatContentForAI(env, true)).toBe('[Document: report.pdf — Q1 report]');
  });

  it('document without caption → [Document: filename]', () => {
    const env = makeEnvelope({ type: 'document', media: { mimeType: 'application/pdf' }, fileName: 'report.pdf' });
    expect(formatContentForAI(env, true)).toBe('[Document: report.pdf]');
  });

  it('sticker → [Sticker]', () => {
    const env = makeEnvelope({ type: 'sticker', media: { mimeType: 'image/webp' } });
    expect(formatContentForAI(env, true)).toBe('[Sticker]');
  });

  it('location with name → [Location: lat, lng — name]', () => {
    const env = makeEnvelope({ type: 'location', latitude: 40.4168, longitude: -3.7038, name: 'Madrid' });
    expect(formatContentForAI(env, true)).toBe('[Location: 40.4168, -3.7038 — Madrid]');
  });

  it('location without name → [Location: lat, lng]', () => {
    const env = makeEnvelope({ type: 'location', latitude: 40.4168, longitude: -3.7038 });
    expect(formatContentForAI(env, true)).toBe('[Location: 40.4168, -3.7038]');
  });

  it('contact single → [Contact: name]', () => {
    const env = makeEnvelope({ type: 'contact', contacts: [{ name: 'Alice', phones: [{ number: '+1234' }] }] });
    expect(formatContentForAI(env, true)).toBe('[Contact: Alice]');
  });

  it('contact multiple → [Contact: name1, name2]', () => {
    const env = makeEnvelope({
      type: 'contact',
      contacts: [
        { name: 'Alice', phones: [{ number: '+1234' }] },
        { name: 'Bob', phones: [{ number: '+5678' }] },
      ],
    });
    expect(formatContentForAI(env, true)).toBe('[Contact: Alice, Bob]');
  });

  it('reaction → [Reacted with emoji]', () => {
    const env = makeEnvelope({ type: 'reaction', emoji: '👍', targetMessageId: 'msg-1' });
    expect(formatContentForAI(env, true)).toBe('[Reacted with 👍]');
  });

  it('poll → [Poll: question]', () => {
    const env = makeEnvelope({ type: 'poll', question: 'Lunch?', options: ['Pizza', 'Sushi'] });
    expect(formatContentForAI(env, true)).toBe('[Poll: Lunch?]');
  });

  it('interactive_response → [Selected: text]', () => {
    const env = makeEnvelope({ type: 'interactive_response', responseType: 'button', selectedId: 'btn-1', selectedText: 'Yes' });
    expect(formatContentForAI(env, true)).toBe('[Selected: Yes]');
  });

  it('system with body → [System: body]', () => {
    const env = makeEnvelope({ type: 'system', eventType: 'group_create', body: 'Alice created the group' });
    expect(formatContentForAI(env, true)).toBe('[System: Alice created the group]');
  });

  it('system without body → [System: eventType]', () => {
    const env = makeEnvelope({ type: 'system', eventType: 'group_create' });
    expect(formatContentForAI(env, true)).toBe('[System: group_create]');
  });

  it('unknown type → [Unknown message type]', () => {
    const env = makeEnvelope({ type: 'unknown' });
    expect(formatContentForAI(env, true)).toBe('[Unknown message type]');
  });
});

// ── extractPreview ──────────────────────────────────────────────

describe('extractPreview', () => {
  it('text → first 200 chars', () => {
    const env = makeEnvelope({ type: 'text', body: 'Short text' });
    expect(extractPreview(env)).toBe('Short text');
  });

  it('text long → truncated at 200', () => {
    const long = 'A'.repeat(300);
    const env = makeEnvelope({ type: 'text', body: long });
    expect(extractPreview(env)).toBe('A'.repeat(200));
  });

  it('image with caption → caption truncated', () => {
    const env = makeEnvelope({ type: 'image', media: { mimeType: 'image/jpeg' }, caption: 'Beautiful sunset' });
    expect(extractPreview(env)).toBe('Beautiful sunset');
  });

  it('image with long caption → truncated at 200', () => {
    const long = 'B'.repeat(300);
    const env = makeEnvelope({ type: 'image', media: { mimeType: 'image/jpeg' }, caption: long });
    expect(extractPreview(env)).toBe('B'.repeat(200));
  });

  it('image without caption → [Image]', () => {
    const env = makeEnvelope({ type: 'image', media: { mimeType: 'image/jpeg' } });
    expect(extractPreview(env)).toBe('[Image]');
  });

  it('video with caption → caption', () => {
    const env = makeEnvelope({ type: 'video', media: { mimeType: 'video/mp4' }, caption: 'Clip' });
    expect(extractPreview(env)).toBe('Clip');
  });

  it('video without caption → [Video]', () => {
    const env = makeEnvelope({ type: 'video', media: { mimeType: 'video/mp4' } });
    expect(extractPreview(env)).toBe('[Video]');
  });

  it('audio voiceNote → [Voice Note]', () => {
    const env = makeEnvelope({ type: 'audio', media: { mimeType: 'audio/ogg' }, isVoiceNote: true });
    expect(extractPreview(env)).toBe('[Voice Note]');
  });

  it('audio regular → [Audio]', () => {
    const env = makeEnvelope({ type: 'audio', media: { mimeType: 'audio/ogg' }, isVoiceNote: false });
    expect(extractPreview(env)).toBe('[Audio]');
  });

  it('document → fileName', () => {
    const env = makeEnvelope({ type: 'document', media: { mimeType: 'application/pdf' }, fileName: 'report.pdf' });
    expect(extractPreview(env)).toBe('report.pdf');
  });

  it('location → [Location: lat,lng]', () => {
    const env = makeEnvelope({ type: 'location', latitude: 40.4168, longitude: -3.7038 });
    expect(extractPreview(env)).toBe('[Location: 40.4168,-3.7038]');
  });

  it('contact → comma-joined names', () => {
    const env = makeEnvelope({
      type: 'contact',
      contacts: [
        { name: 'Alice', phones: [{ number: '+1' }] },
        { name: 'Bob', phones: [{ number: '+2' }] },
      ],
    });
    expect(extractPreview(env)).toBe('Alice, Bob');
  });

  it('reaction → emoji', () => {
    const env = makeEnvelope({ type: 'reaction', emoji: '❤️', targetMessageId: 'msg-1' });
    expect(extractPreview(env)).toBe('❤️');
  });

  it('poll → question', () => {
    const env = makeEnvelope({ type: 'poll', question: 'Lunch?', options: ['A', 'B'] });
    expect(extractPreview(env)).toBe('Lunch?');
  });

  it('sticker → [Sticker]', () => {
    const env = makeEnvelope({ type: 'sticker', media: { mimeType: 'image/webp' } });
    expect(extractPreview(env)).toBe('[Sticker]');
  });

  it('unknown → null', () => {
    const env = makeEnvelope({ type: 'unknown' });
    expect(extractPreview(env)).toBeNull();
  });
});

// ── parseJsonColumn ─────────────────────────────────────────────

describe('parseJsonColumn', () => {
  it('null → undefined', () => {
    expect(parseJsonColumn(null)).toBeUndefined();
  });

  it('undefined → undefined', () => {
    expect(parseJsonColumn(undefined)).toBeUndefined();
  });

  it('valid JSON string → parsed object', () => {
    const result = parseJsonColumn<{ name: string }>('{"name":"Alice"}');
    expect(result).toEqual({ name: 'Alice' });
  });

  it('already-parsed object → returns same object', () => {
    const obj = { name: 'Alice' } as Record<string, unknown>;
    expect(parseJsonColumn(obj)).toBe(obj);
  });
});

describe('parseJsonColumnRequired', () => {
  it('JSON string → parsed object', () => {
    const result = parseJsonColumnRequired<{ id: number }>('{"id":42}');
    expect(result).toEqual({ id: 42 });
  });

  it('already-parsed object → returns same object', () => {
    const obj = { id: 42 } as Record<string, unknown>;
    expect(parseJsonColumnRequired(obj)).toBe(obj);
  });
});

// ── toUTC ───────────────────────────────────────────────────────

describe('toUTC', () => {
  it('Date object → ISO string ending in Z', () => {
    const date = new Date('2026-04-05T10:00:00.000Z');
    const result = toUTC(date);
    expect(result).toBe('2026-04-05T10:00:00.000Z');
    expect(result.endsWith('Z')).toBe(true);
  });

  it('string → ISO string', () => {
    const result = toUTC('2026-04-05T10:00:00.000Z');
    expect(result).toBe('2026-04-05T10:00:00.000Z');
  });

  it('number (timestamp) → ISO string', () => {
    const ts = new Date('2026-04-05T10:00:00.000Z').getTime();
    const result = toUTC(ts);
    expect(result).toBe('2026-04-05T10:00:00.000Z');
  });
});

// ── nowUTC ──────────────────────────────────────────────────────

describe('nowUTC', () => {
  it('returns string ending in Z', () => {
    const result = nowUTC();
    expect(result.endsWith('Z')).toBe(true);
  });
});
