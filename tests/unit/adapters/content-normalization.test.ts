import { describe, it, expect } from 'vitest';
import { mapWhatsAppMessageToContent, mapWhatsAppContext, buildWhatsAppEnvelope } from '../../../src/integrations/whatsapp/whatsapp-content.mapper.js';
import { mapBaileysToWhatsAppEvent } from '../../../src/integrations/whatsapp/baileys/baileys.mapper.js';
import type { WhatsAppMessage, WhatsAppMessageContext, WhatsAppInboundEvent } from '../../../src/integrations/whatsapp/whatsapp-channel.types.js';
import type { ChannelAccount } from '../../../src/core/accounts/channel-account.js';

const testAccount: ChannelAccount = {
  id: 'wa-test', alias: 'Test', channel: 'whatsapp', provider: 'baileys',
  status: 'active', identity: { channel: 'whatsapp', phoneNumber: '+14155550001' },
  credentialsRef: '', providerConfig: {},
  metadata: { owner: 'test', environment: 'production', tags: [] },
};

describe('Content Normalization: WhatsApp → Standardized', () => {
  describe('mapWhatsAppMessageToContent', () => {
    it('should normalize text message', () => {
      const content = mapWhatsAppMessageToContent({ type: 'text', body: 'Hello world' });
      expect(content).toEqual({ type: 'text', body: 'Hello world' });
    });

    it('should normalize image with caption', () => {
      const content = mapWhatsAppMessageToContent({
        type: 'image', mediaId: 'img-123', mimeType: 'image/jpeg',
        caption: 'Nice photo', fileSize: 50000,
      });
      expect(content.type).toBe('image');
      if (content.type === 'image') {
        expect(content.media.id).toBe('img-123');
        expect(content.media.mimeType).toBe('image/jpeg');
        expect(content.media.size).toBe(50000);
        expect(content.caption).toBe('Nice photo');
      }
    });

    it('should normalize audio with voice note flag', () => {
      const content = mapWhatsAppMessageToContent({
        type: 'audio', mediaId: 'aud-1', mimeType: 'audio/ogg',
        isVoiceNote: true, duration: 15, fileSize: 12000,
      });
      expect(content.type).toBe('audio');
      if (content.type === 'audio') {
        expect(content.isVoiceNote).toBe(true);
        expect(content.duration).toBe(15);
        expect(content.media.mimeType).toBe('audio/ogg');
      }
    });

    it('should normalize video with caption and duration', () => {
      const content = mapWhatsAppMessageToContent({
        type: 'video', mediaId: 'vid-1', mimeType: 'video/mp4',
        caption: 'Watch this', duration: 30, fileSize: 500000,
      });
      expect(content.type).toBe('video');
      if (content.type === 'video') {
        expect(content.caption).toBe('Watch this');
        expect(content.duration).toBe(30);
        expect(content.media.size).toBe(500000);
      }
    });

    it('should normalize document with filename', () => {
      const content = mapWhatsAppMessageToContent({
        type: 'document', mediaId: 'doc-1', mimeType: 'application/pdf',
        fileName: 'report.pdf', caption: 'Q1 Report', fileSize: 1000000,
      });
      expect(content.type).toBe('document');
      if (content.type === 'document') {
        expect(content.fileName).toBe('report.pdf');
        expect(content.caption).toBe('Q1 Report');
        expect(content.media.mimeType).toBe('application/pdf');
      }
    });

    it('should normalize sticker', () => {
      const content = mapWhatsAppMessageToContent({
        type: 'sticker', mediaId: 'stk-1', mimeType: 'image/webp', isAnimated: true,
      });
      expect(content.type).toBe('sticker');
      if (content.type === 'sticker') {
        expect(content.isAnimated).toBe(true);
        expect(content.media.mimeType).toBe('image/webp');
      }
    });

    it('should normalize location', () => {
      const content = mapWhatsAppMessageToContent({
        type: 'location', latitude: 40.4168, longitude: -3.7038,
        name: 'Madrid', address: 'Puerta del Sol',
      });
      expect(content).toEqual({
        type: 'location', latitude: 40.4168, longitude: -3.7038,
        name: 'Madrid', address: 'Puerta del Sol', url: undefined,
      });
    });

    it('should normalize contact', () => {
      const content = mapWhatsAppMessageToContent({
        type: 'contact',
        contacts: [{
          name: { formatted: 'John Doe' },
          phones: [{ phone: '+14155551234', type: 'CELL' }],
          emails: [{ email: 'john@example.com', type: 'WORK' }],
        }],
      });
      expect(content.type).toBe('contact');
      if (content.type === 'contact') {
        expect(content.contacts[0]!.name).toBe('John Doe');
        expect(content.contacts[0]!.phones[0]!.number).toBe('+14155551234');
        expect(content.contacts[0]!.emails![0]!.address).toBe('john@example.com');
      }
    });

    it('should normalize reaction', () => {
      const content = mapWhatsAppMessageToContent({
        type: 'reaction', emoji: '❤️', targetMessageId: 'msg-123',
      });
      expect(content).toEqual({
        type: 'reaction', emoji: '❤️', targetMessageId: 'msg-123',
      });
    });

    it('should normalize poll', () => {
      const content = mapWhatsAppMessageToContent({
        type: 'poll', pollName: 'Where to eat?',
        options: ['Pizza', 'Sushi', 'Tacos'], allowMultipleAnswers: false,
      });
      expect(content.type).toBe('poll');
      if (content.type === 'poll') {
        expect(content.question).toBe('Where to eat?');
        expect(content.options).toEqual(['Pizza', 'Sushi', 'Tacos']);
        expect(content.allowMultipleAnswers).toBe(false);
      }
    });

    it('should normalize list response', () => {
      const content = mapWhatsAppMessageToContent({
        type: 'list_response', title: 'Pizza', selectedRowId: 'pizza-1',
        description: 'Margherita',
      });
      expect(content.type).toBe('interactive_response');
      if (content.type === 'interactive_response') {
        expect(content.responseType).toBe('list');
        expect(content.selectedId).toBe('pizza-1');
        expect(content.selectedText).toBe('Pizza');
      }
    });

    it('should normalize button response', () => {
      const content = mapWhatsAppMessageToContent({
        type: 'button_response', selectedButtonId: 'btn-yes', selectedButtonText: 'Yes',
      });
      expect(content.type).toBe('interactive_response');
      if (content.type === 'interactive_response') {
        expect(content.responseType).toBe('button');
        expect(content.selectedId).toBe('btn-yes');
      }
    });

    it('should normalize system message', () => {
      const content = mapWhatsAppMessageToContent({
        type: 'system', eventType: 'participant_added',
        body: 'John was added', affectedParticipants: ['john@wa'],
      });
      expect(content.type).toBe('system');
      if (content.type === 'system') {
        expect(content.eventType).toBe('participant_added');
        expect(content.affectedUsers).toEqual(['john@wa']);
      }
    });

    it('should handle unknown message type', () => {
      const content = mapWhatsAppMessageToContent({
        type: 'call', callId: 'c1', isVideo: true, status: 'missed',
      });
      expect(content.type).toBe('unknown');
    });
  });

  describe('mapWhatsAppContext', () => {
    it('should return undefined for no context', () => {
      expect(mapWhatsAppContext(undefined)).toBeUndefined();
    });

    it('should normalize quoted message (reply)', () => {
      const ctx = mapWhatsAppContext({
        isForwarded: false, isFrequentlyForwarded: false,
        isEphemeral: false, isFromStatusBroadcast: false, isViewOnce: false,
        quotedMessage: { messageId: 'orig-123', body: 'Original text', participant: 'user@wa' },
      });
      expect(ctx?.quotedMessageId).toBe('orig-123');
      expect(ctx?.quotedPreview).toBe('Original text');
    });

    it('should normalize forwarded message', () => {
      const ctx = mapWhatsAppContext({
        isForwarded: true, forwardingScore: 10, isFrequentlyForwarded: true,
        isEphemeral: false, isFromStatusBroadcast: false, isViewOnce: false,
      });
      expect(ctx?.isForwarded).toBe(true);
      expect(ctx?.isFrequentlyForwarded).toBe(true);
    });

    it('should normalize mentions', () => {
      const ctx = mapWhatsAppContext({
        isForwarded: false, isFrequentlyForwarded: false,
        isEphemeral: false, isFromStatusBroadcast: false, isViewOnce: false,
        mentionedIds: ['user1@wa', 'user2@wa'],
      });
      expect(ctx?.mentions).toEqual(['user1@wa', 'user2@wa']);
    });

    it('should normalize ephemeral and view-once', () => {
      const ctx = mapWhatsAppContext({
        isForwarded: false, isFrequentlyForwarded: false,
        isEphemeral: true, ephemeralDuration: 86400,
        isFromStatusBroadcast: false, isViewOnce: true,
      });
      expect(ctx?.isEphemeral).toBe(true);
      expect(ctx?.isViewOnce).toBe(true);
    });
  });

  describe('buildWhatsAppEnvelope (full pipeline)', () => {
    it('should produce a complete standardized envelope', () => {
      const event: WhatsAppInboundEvent = {
        messageId: 'wa-msg-1',
        from: { wid: '34600000001@s.whatsapp.net', pushName: 'John', isBusinessAccount: true, isBroadcast: false },
        chat: { chatId: '34600000001@s.whatsapp.net', isGroup: false },
        message: { type: 'text', body: 'Hello from standardized test' },
        context: {
          isForwarded: false, isFrequentlyForwarded: false,
          isEphemeral: false, isFromStatusBroadcast: false, isViewOnce: false,
          quotedMessage: { messageId: 'prev-1', body: 'Previous message' },
        },
        raw: {},
      };

      const envelope = buildWhatsAppEnvelope(event, testAccount);

      // Envelope structure
      expect(envelope.id).toMatch(/^msg_/);
      expect(envelope.channel).toBe('whatsapp');
      expect(envelope.direction).toBe('inbound');
      expect(envelope.sender.displayName).toBe('John');

      // Standardized content
      expect(envelope.content.type).toBe('text');
      if (envelope.content.type === 'text') {
        expect(envelope.content.body).toBe('Hello from standardized test');
      }

      // Context with quote
      expect(envelope.context?.quotedMessageId).toBe('prev-1');
      expect(envelope.context?.quotedPreview).toBe('Previous message');

      // Channel details
      expect(envelope.channelDetails?.platform).toBe('whatsapp');
      expect(envelope.channelDetails?.messageId).toBe('wa-msg-1');
      expect(envelope.channelDetails?.isBusinessAccount).toBe(true);

      // No raw channelPayload — clean!
      expect((envelope as Record<string, unknown>)['channelPayload']).toBeUndefined();
    });

    it('should produce standardized media envelope', () => {
      const event: WhatsAppInboundEvent = {
        messageId: 'wa-img-1',
        from: { wid: '34600000001@s.whatsapp.net', pushName: 'Jane', isBusinessAccount: false, isBroadcast: false },
        chat: { chatId: '34600000001@s.whatsapp.net', isGroup: false },
        message: { type: 'image', mediaId: 'media-123', mimeType: 'image/jpeg', caption: 'My photo', fileSize: 42000 },
        raw: {},
      };

      const envelope = buildWhatsAppEnvelope(event, testAccount);

      expect(envelope.content.type).toBe('image');
      if (envelope.content.type === 'image') {
        expect(envelope.content.media.id).toBe('media-123');
        expect(envelope.content.media.mimeType).toBe('image/jpeg');
        expect(envelope.content.media.size).toBe(42000);
        expect(envelope.content.caption).toBe('My photo');
      }
    });
  });
});

describe('Baileys Raw → Standardized Content (end-to-end)', () => {
  it('should normalize Baileys text conversation', () => {
    const event = mapBaileysToWhatsAppEvent({
      key: { remoteJid: '34600000001@s.whatsapp.net', id: 'test-1', fromMe: false },
      message: { conversation: 'Hello from Baileys' },
      pushName: 'TestUser',
      messageTimestamp: 1700000000,
    });

    const envelope = buildWhatsAppEnvelope(event, testAccount);
    expect(envelope.content).toEqual({ type: 'text', body: 'Hello from Baileys' });
    expect(envelope.sender.displayName).toBe('TestUser');
  });

  it('should normalize Baileys extended text (reply)', () => {
    const event = mapBaileysToWhatsAppEvent({
      key: { remoteJid: '34600000001@s.whatsapp.net', id: 'test-2', fromMe: false },
      message: {
        extendedTextMessage: {
          text: 'This is a reply',
          contextInfo: {
            stanzaId: 'original-msg-id',
            quotedMessage: { conversation: 'Original message text' },
            participant: '34600000002@s.whatsapp.net',
          },
        },
      },
      pushName: 'Replier',
    });

    const envelope = buildWhatsAppEnvelope(event, testAccount);
    expect(envelope.content).toEqual({ type: 'text', body: 'This is a reply' });
    expect(envelope.context?.quotedMessageId).toBe('original-msg-id');
    expect(envelope.context?.quotedPreview).toBe('Original message text');
  });

  it('should normalize Baileys image message', () => {
    const event = mapBaileysToWhatsAppEvent({
      key: { remoteJid: '34600000001@s.whatsapp.net', id: 'img-1', fromMe: false },
      message: {
        imageMessage: {
          mimetype: 'image/png',
          caption: 'Check this out',
          fileLength: 150000 as unknown as Long,
        },
      },
      pushName: 'PhotoSender',
    });

    const envelope = buildWhatsAppEnvelope(event, testAccount);
    expect(envelope.content.type).toBe('image');
    if (envelope.content.type === 'image') {
      expect(envelope.content.caption).toBe('Check this out');
      expect(envelope.content.media.mimeType).toBe('image/png');
      expect(envelope.content.media.size).toBe(150000);
      expect(envelope.content.media.id).toBe('img-1');
    }
  });

  it('should normalize Baileys voice note', () => {
    const event = mapBaileysToWhatsAppEvent({
      key: { remoteJid: '34600000001@s.whatsapp.net', id: 'ptt-1', fromMe: false },
      message: {
        audioMessage: {
          mimetype: 'audio/ogg; codecs=opus',
          ptt: true,
          seconds: 12,
          fileLength: 8000 as unknown as Long,
        },
      },
      pushName: 'VoiceSender',
    });

    const envelope = buildWhatsAppEnvelope(event, testAccount);
    expect(envelope.content.type).toBe('audio');
    if (envelope.content.type === 'audio') {
      expect(envelope.content.isVoiceNote).toBe(true);
      expect(envelope.content.duration).toBe(12);
    }
  });

  it('should normalize Baileys sticker', () => {
    const event = mapBaileysToWhatsAppEvent({
      key: { remoteJid: '34600000001@s.whatsapp.net', id: 'stk-1', fromMe: false },
      message: {
        stickerMessage: {
          mimetype: 'image/webp',
          isAnimated: true,
        },
      },
      pushName: 'StickerFan',
    });

    const envelope = buildWhatsAppEnvelope(event, testAccount);
    expect(envelope.content.type).toBe('sticker');
    if (envelope.content.type === 'sticker') {
      expect(envelope.content.isAnimated).toBe(true);
      expect(envelope.content.media.mimeType).toBe('image/webp');
    }
  });

  it('should normalize Baileys location', () => {
    const event = mapBaileysToWhatsAppEvent({
      key: { remoteJid: '34600000001@s.whatsapp.net', id: 'loc-1', fromMe: false },
      message: {
        locationMessage: {
          degreesLatitude: 40.4168,
          degreesLongitude: -3.7038,
          name: 'Madrid',
          address: 'Puerta del Sol',
        },
      },
      pushName: 'TravelUser',
    });

    const envelope = buildWhatsAppEnvelope(event, testAccount);
    expect(envelope.content.type).toBe('location');
    if (envelope.content.type === 'location') {
      expect(envelope.content.latitude).toBe(40.4168);
      expect(envelope.content.longitude).toBe(-3.7038);
      expect(envelope.content.name).toBe('Madrid');
    }
  });

  it('should normalize Baileys reaction', () => {
    const event = mapBaileysToWhatsAppEvent({
      key: { remoteJid: '34600000001@s.whatsapp.net', id: 'react-1', fromMe: false },
      message: {
        reactionMessage: {
          text: '👍',
          key: { remoteJid: '34600000001@s.whatsapp.net', id: 'target-msg-1' },
        },
      },
      pushName: 'Reactor',
    });

    const envelope = buildWhatsAppEnvelope(event, testAccount);
    expect(envelope.content).toEqual({
      type: 'reaction',
      emoji: '👍',
      targetMessageId: 'target-msg-1',
    });
  });

  it('should normalize Baileys document', () => {
    const event = mapBaileysToWhatsAppEvent({
      key: { remoteJid: '34600000001@s.whatsapp.net', id: 'doc-1', fromMe: false },
      message: {
        documentMessage: {
          mimetype: 'application/pdf',
          fileName: 'report.pdf',
          fileLength: 250000 as unknown as Long,
          caption: 'Q1 Report',
        },
      },
      pushName: 'DocSender',
    });

    const envelope = buildWhatsAppEnvelope(event, testAccount);
    expect(envelope.content.type).toBe('document');
    if (envelope.content.type === 'document') {
      expect(envelope.content.fileName).toBe('report.pdf');
      expect(envelope.content.caption).toBe('Q1 Report');
      expect(envelope.content.media.mimeType).toBe('application/pdf');
    }
  });

  it('should normalize Baileys contact card', () => {
    const event = mapBaileysToWhatsAppEvent({
      key: { remoteJid: '34600000001@s.whatsapp.net', id: 'contact-1', fromMe: false },
      message: {
        contactMessage: {
          displayName: 'John Doe',
          vcard: 'BEGIN:VCARD\nVERSION:3.0\nFN:John Doe\nTEL;type=CELL:+14155551234\nEND:VCARD',
        },
      },
      pushName: 'ContactSharer',
    });

    const envelope = buildWhatsAppEnvelope(event, testAccount);
    expect(envelope.content.type).toBe('contact');
    if (envelope.content.type === 'contact') {
      expect(envelope.content.contacts[0]!.name).toBe('John Doe');
      expect(envelope.content.contacts[0]!.phones[0]!.number).toBe('+14155551234');
    }
  });

  it('should normalize Baileys view-once image', () => {
    const event = mapBaileysToWhatsAppEvent({
      key: { remoteJid: '34600000001@s.whatsapp.net', id: 'vo-1', fromMe: false },
      message: {
        viewOnceMessage: {
          message: {
            imageMessage: {
              mimetype: 'image/jpeg',
              caption: 'View once photo',
              fileLength: 80000 as unknown as Long,
            },
          },
        },
      },
      pushName: 'SecretSender',
    });

    const envelope = buildWhatsAppEnvelope(event, testAccount);
    expect(envelope.content.type).toBe('image');
    expect(envelope.context?.isViewOnce).toBe(true);
  });

  it('should normalize Baileys forwarded message', () => {
    const event = mapBaileysToWhatsAppEvent({
      key: { remoteJid: '34600000001@s.whatsapp.net', id: 'fwd-1', fromMe: false },
      message: {
        extendedTextMessage: {
          text: 'This was forwarded',
          contextInfo: {
            isForwarded: true,
            forwardingScore: 10,
          },
        },
      },
      pushName: 'Forwarder',
    });

    const envelope = buildWhatsAppEnvelope(event, testAccount);
    expect(envelope.content).toEqual({ type: 'text', body: 'This was forwarded' });
    expect(envelope.context?.isForwarded).toBe(true);
    expect(envelope.context?.isFrequentlyForwarded).toBe(true);
  });
});
