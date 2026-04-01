import { describe, it, expect } from 'vitest';
import {
  mapWwebjsToWhatsAppEvent,
  mapWhatsAppEventToContentSummary,
  buildWhatsAppEnvelope,
} from '../../../src/integrations/whatsapp/wwebjs-api/wwebjs.mapper.js';
import type { WwebjsInboundPayload } from '../../../src/integrations/whatsapp/wwebjs-api/wwebjs.types.js';
import type { ChannelAccount } from '../../../src/core/accounts/channel-account.js';

const testAccount: ChannelAccount = {
  id: 'wa-acme',
  alias: 'Acme WhatsApp',
  channel: 'whatsapp',
  provider: 'wwebjs-api',
  status: 'active',
  identity: { channel: 'whatsapp', phoneNumber: '+34600000001' },
  credentialsRef: 'WWEBJS_ACME',
  providerConfig: { baseUrl: 'http://localhost:3001' },
  metadata: {
    owner: 'acme-corp',
    environment: 'production',
    tags: ['support', 'acme'],
  },
};

function makeTextPayload(body: string): WwebjsInboundPayload {
  return {
    event: 'message',
    data: {
      id: { _serialized: 'wamid.test123' },
      from: '34699000001@c.us',
      to: '34600000001@c.us',
      body,
      type: 'chat',
      timestamp: 1709100600,
      fromMe: false,
      hasMedia: false,
      hasQuotedMsg: false,
      isForwarded: false,
      isStatus: false,
      notifyName: 'Ciudadano',
      chat: {
        id: { _serialized: '34699000001@c.us' },
        name: 'Ciudadano',
        isGroup: false,
      },
    },
  };
}

function makeImagePayload(): WwebjsInboundPayload {
  return {
    event: 'message',
    data: {
      id: { _serialized: 'wamid.img456' },
      from: '34699000001@c.us',
      to: '34600000001@c.us',
      type: 'image',
      timestamp: 1709100600,
      fromMe: false,
      hasMedia: true,
      hasQuotedMsg: false,
      isForwarded: false,
      isStatus: false,
      notifyName: 'Ciudadano',
      mimetype: 'image/jpeg',
      caption: 'Photo of DEA',
      filesize: 204800,
      chat: {
        id: { _serialized: '34699000001@c.us' },
        isGroup: false,
      },
    },
  };
}

function makeAudioPayload(isVoiceNote: boolean): WwebjsInboundPayload {
  return {
    event: 'message',
    data: {
      id: { _serialized: 'wamid.audio789' },
      from: '34699000001@c.us',
      to: '34600000001@c.us',
      type: isVoiceNote ? 'ptt' : 'audio',
      timestamp: 1709100600,
      fromMe: false,
      hasMedia: true,
      hasQuotedMsg: false,
      isForwarded: false,
      isStatus: false,
      notifyName: 'Ciudadano',
      mimetype: 'audio/ogg; codecs=opus',
      duration: 15,
      chat: {
        id: { _serialized: '34699000001@c.us' },
        isGroup: false,
      },
    },
  };
}

function makeGroupPayload(): WwebjsInboundPayload {
  return {
    event: 'message',
    data: {
      id: { _serialized: 'wamid.grp101' },
      from: '34699000001@c.us',
      to: '34600000001@c.us',
      body: 'Hello group!',
      type: 'chat',
      timestamp: 1709100600,
      fromMe: false,
      hasMedia: false,
      hasQuotedMsg: false,
      isForwarded: true,
      forwardingScore: 7,
      isStatus: false,
      notifyName: 'Ciudadano',
      author: '34699000001@c.us',
      chat: {
        id: { _serialized: '120363001234567890@g.us' },
        name: 'Emergency Team',
        isGroup: true,
        groupMetadata: {
          subject: 'Emergency Team',
          desc: 'Emergency coordination group',
          participants: [
            { id: { _serialized: '34699000001@c.us' }, isAdmin: false, isSuperAdmin: false },
            { id: { _serialized: '34600000001@c.us' }, isAdmin: true, isSuperAdmin: true },
          ],
          creation: 1700000000,
          announce: false,
        },
      },
    },
  };
}

describe('mapWwebjsToWhatsAppEvent', () => {
  it('should map text message correctly', () => {
    const payload = makeTextPayload('He encontrado un DEA en la calle Mayor');
    const event = mapWwebjsToWhatsAppEvent(payload);

    expect(event.messageId).toBe('wamid.test123');
    expect(event.from.wid).toBe('34699000001@c.us');
    expect(event.from.pushName).toBe('Ciudadano');
    expect(event.chat.chatId).toBe('34699000001@c.us');
    expect(event.chat.isGroup).toBe(false);
    expect(event.message).toEqual({
      type: 'text',
      body: 'He encontrado un DEA en la calle Mayor',
    });
    expect(event.context?.isForwarded).toBe(false);
    expect(event.raw).toBe(payload);
  });

  it('should map image message correctly', () => {
    const payload = makeImagePayload();
    const event = mapWwebjsToWhatsAppEvent(payload);

    expect(event.message.type).toBe('image');
    if (event.message.type === 'image') {
      expect(event.message.mimeType).toBe('image/jpeg');
      expect(event.message.caption).toBe('Photo of DEA');
      expect(event.message.fileSize).toBe(204800);
    }
  });

  it('should distinguish voice note from audio', () => {
    const voiceNote = mapWwebjsToWhatsAppEvent(makeAudioPayload(true));
    const audio = mapWwebjsToWhatsAppEvent(makeAudioPayload(false));

    expect(voiceNote.message.type).toBe('audio');
    if (voiceNote.message.type === 'audio') {
      expect(voiceNote.message.isVoiceNote).toBe(true);
      expect(voiceNote.message.duration).toBe(15);
    }

    expect(audio.message.type).toBe('audio');
    if (audio.message.type === 'audio') {
      expect(audio.message.isVoiceNote).toBe(false);
    }
  });

  it('should map group message with metadata', () => {
    const payload = makeGroupPayload();
    const event = mapWwebjsToWhatsAppEvent(payload);

    expect(event.chat.isGroup).toBe(true);
    expect(event.chat.groupMetadata?.name).toBe('Emergency Team');
    expect(event.chat.groupMetadata?.participants).toHaveLength(2);
    expect(event.chat.groupMetadata?.admins).toContain('34600000001@c.us');
    expect(event.chat.groupMetadata?.isAnnouncement).toBe(false);
    expect(event.context?.isForwarded).toBe(true);
    expect(event.context?.isFrequentlyForwarded).toBe(true);
    expect(event.context?.forwardingScore).toBe(7);
  });
});

describe('mapWhatsAppEventToContentSummary', () => {
  it('should map text message summary', () => {
    const summary = mapWhatsAppEventToContentSummary({ type: 'text', body: 'Hello world' });
    expect(summary.type).toBe('text');
    expect(summary.preview).toBe('Hello world');
    expect(summary.hasMedia).toBe(false);
  });

  it('should truncate long text preview to 100 chars', () => {
    const longText = 'A'.repeat(200);
    const summary = mapWhatsAppEventToContentSummary({ type: 'text', body: longText });
    expect(summary.preview).toHaveLength(100);
  });

  it('should mark media messages correctly', () => {
    const imageSummary = mapWhatsAppEventToContentSummary({
      type: 'image',
      mediaId: 'x',
      mimeType: 'image/jpeg',
    });
    expect(imageSummary.type).toBe('image');
    expect(imageSummary.hasMedia).toBe(true);

    const audioSummary = mapWhatsAppEventToContentSummary({
      type: 'audio',
      mediaId: 'x',
      mimeType: 'audio/ogg',
      isVoiceNote: true,
    });
    expect(audioSummary.type).toBe('audio');
    expect(audioSummary.hasMedia).toBe(true);
  });

  it('should handle reaction message', () => {
    const summary = mapWhatsAppEventToContentSummary({
      type: 'reaction',
      emoji: '👍',
      targetMessageId: 'msg-1',
    });
    expect(summary.type).toBe('reaction');
    expect(summary.preview).toBe('👍');
    expect(summary.hasMedia).toBe(false);
  });
});

describe('buildWhatsAppEnvelope', () => {
  it('should build a complete unified envelope', () => {
    const payload = makeTextPayload('Test message');
    const event = mapWwebjsToWhatsAppEvent(payload);
    const envelope = buildWhatsAppEnvelope(event, testAccount);

    expect(envelope.id).toMatch(/^msg_/);
    expect(envelope.accountId).toBe('wa-acme');
    expect(envelope.channel).toBe('whatsapp');
    expect(envelope.direction).toBe('inbound');
    expect(envelope.conversationId).toBe('34699000001@c.us');
    expect(envelope.sender.id).toBe('34699000001@c.us');
    expect(envelope.sender.displayName).toBe('Ciudadano');
    expect(envelope.recipient.id).toBe('+34600000001');
    expect(envelope.contentSummary.type).toBe('text');
    expect(envelope.contentSummary.preview).toBe('Test message');
    expect(envelope.contentSummary.hasMedia).toBe(false);
    expect(envelope.channelPayload).toBe(event);
    expect(envelope.gateway.adapterId).toBe('wwebjs-api');
    expect(envelope.gateway.account.id).toBe('wa-acme');
    expect(envelope.gateway.account.alias).toBe('Acme WhatsApp');
    expect(envelope.gateway.account.owner).toBe('acme-corp');
    expect(envelope.gateway.account.tags).toEqual(['support', 'acme']);
  });
});
