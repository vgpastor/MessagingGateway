import { describe, it, expect } from 'vitest';
import { mapBaileysToWhatsAppEvent } from '../../../src/integrations/whatsapp/baileys/baileys.mapper.js';
import { buildWhatsAppEnvelope, mapWhatsAppEventToContentSummary } from '../../../src/integrations/whatsapp/wwebjs-api/wwebjs.mapper.js';
import type { ChannelAccount } from '../../../src/domain/accounts/channel-account.js';

const testAccount: ChannelAccount = {
  id: 'wa-baileys-test',
  alias: 'Baileys Test',
  channel: 'whatsapp',
  provider: 'baileys',
  status: 'active',
  identity: { channel: 'whatsapp', phoneNumber: '+34600000001' },
  credentialsRef: 'BAILEYS_TEST',
  providerConfig: { authDir: 'data/baileys-auth/test' },
  metadata: {
    owner: 'test-team',
    environment: 'production',
    tags: ['whatsapp', 'baileys', 'test'],
  },
};

function makeTextMessage(body: string) {
  return {
    key: {
      remoteJid: '34699000001@s.whatsapp.net',
      fromMe: false,
      id: 'BAILEYS_MSG_001',
    },
    pushName: 'TestUser',
    messageTimestamp: 1709100600,
    message: {
      conversation: body,
    },
  };
}

function makeExtendedTextMessage(text: string) {
  return {
    key: {
      remoteJid: '34699000001@s.whatsapp.net',
      fromMe: false,
      id: 'BAILEYS_MSG_002',
    },
    pushName: 'TestUser',
    messageTimestamp: 1709100600,
    message: {
      extendedTextMessage: {
        text,
        contextInfo: {
          isForwarded: true,
          forwardingScore: 7,
          mentionedJid: ['34699000002@s.whatsapp.net'],
        },
      },
    },
  };
}

function makeImageMessage() {
  return {
    key: {
      remoteJid: '34699000001@s.whatsapp.net',
      fromMe: false,
      id: 'BAILEYS_MSG_003',
    },
    pushName: 'TestUser',
    messageTimestamp: 1709100600,
    message: {
      imageMessage: {
        mimetype: 'image/jpeg',
        caption: 'Check this photo',
        fileLength: 204800,
        url: 'https://mmg.whatsapp.net/v/image/test',
      },
    },
  };
}

function makeAudioMessage(ptt: boolean) {
  return {
    key: {
      remoteJid: '34699000001@s.whatsapp.net',
      fromMe: false,
      id: 'BAILEYS_MSG_004',
    },
    pushName: 'TestUser',
    messageTimestamp: 1709100600,
    message: {
      audioMessage: {
        mimetype: 'audio/ogg; codecs=opus',
        ptt,
        seconds: 15,
        fileLength: 50000,
      },
    },
  };
}

function makeVideoMessage() {
  return {
    key: {
      remoteJid: '34699000001@s.whatsapp.net',
      fromMe: false,
      id: 'BAILEYS_MSG_005',
    },
    pushName: 'TestUser',
    messageTimestamp: 1709100600,
    message: {
      videoMessage: {
        mimetype: 'video/mp4',
        caption: 'Video content',
        seconds: 30,
        fileLength: 5000000,
      },
    },
  };
}

function makeDocumentMessage() {
  return {
    key: {
      remoteJid: '34699000001@s.whatsapp.net',
      fromMe: false,
      id: 'BAILEYS_MSG_006',
    },
    pushName: 'TestUser',
    messageTimestamp: 1709100600,
    message: {
      documentMessage: {
        mimetype: 'application/pdf',
        fileName: 'report.pdf',
        caption: 'Monthly report',
        fileLength: 1024000,
      },
    },
  };
}

function makeLocationMessage() {
  return {
    key: {
      remoteJid: '34699000001@s.whatsapp.net',
      fromMe: false,
      id: 'BAILEYS_MSG_007',
    },
    pushName: 'TestUser',
    messageTimestamp: 1709100600,
    message: {
      locationMessage: {
        degreesLatitude: 40.4168,
        degreesLongitude: -3.7038,
        name: 'Madrid',
        address: 'Puerta del Sol, Madrid',
      },
    },
  };
}

function makeStickerMessage() {
  return {
    key: {
      remoteJid: '34699000001@s.whatsapp.net',
      fromMe: false,
      id: 'BAILEYS_MSG_008',
    },
    pushName: 'TestUser',
    messageTimestamp: 1709100600,
    message: {
      stickerMessage: {
        mimetype: 'image/webp',
        isAnimated: true,
      },
    },
  };
}

function makeContactMessage() {
  return {
    key: {
      remoteJid: '34699000001@s.whatsapp.net',
      fromMe: false,
      id: 'BAILEYS_MSG_009',
    },
    pushName: 'TestUser',
    messageTimestamp: 1709100600,
    message: {
      contactMessage: {
        displayName: 'John Doe',
        vcard: 'BEGIN:VCARD\nVERSION:3.0\nFN:John Doe\nTEL;type=CELL:+1234567890\nEND:VCARD',
      },
    },
  };
}

function makeReactionMessage() {
  return {
    key: {
      remoteJid: '34699000001@s.whatsapp.net',
      fromMe: false,
      id: 'BAILEYS_MSG_010',
    },
    pushName: 'TestUser',
    messageTimestamp: 1709100600,
    message: {
      reactionMessage: {
        text: '👍',
        key: {
          remoteJid: '34699000001@s.whatsapp.net',
          fromMe: true,
          id: 'BAILEYS_MSG_001',
        },
      },
    },
  };
}

function makeGroupMessage() {
  return {
    key: {
      remoteJid: '120363001234567890@g.us',
      fromMe: false,
      id: 'BAILEYS_MSG_011',
      participant: '34699000001@s.whatsapp.net',
    },
    pushName: 'GroupMember',
    messageTimestamp: 1709100600,
    message: {
      conversation: 'Hello group!',
    },
  };
}

function makeViewOnceMessage() {
  return {
    key: {
      remoteJid: '34699000001@s.whatsapp.net',
      fromMe: false,
      id: 'BAILEYS_MSG_012',
    },
    pushName: 'TestUser',
    messageTimestamp: 1709100600,
    message: {
      viewOnceMessage: {
        message: {
          imageMessage: {
            mimetype: 'image/jpeg',
            caption: 'View once photo',
            fileLength: 100000,
          },
        },
      },
    },
  };
}

describe('mapBaileysToWhatsAppEvent', () => {
  it('should map text message (conversation) correctly', () => {
    const event = mapBaileysToWhatsAppEvent(makeTextMessage('Hello from Baileys'));

    expect(event.messageId).toBe('BAILEYS_MSG_001');
    expect(event.from.wid).toBe('34699000001@s.whatsapp.net');
    expect(event.from.pushName).toBe('TestUser');
    expect(event.chat.chatId).toBe('34699000001@s.whatsapp.net');
    expect(event.chat.isGroup).toBe(false);
    expect(event.message).toEqual({ type: 'text', body: 'Hello from Baileys' });
    expect(event.context?.isForwarded).toBe(false);
    expect(event.raw).toBeDefined();
  });

  it('should map extended text message correctly', () => {
    const event = mapBaileysToWhatsAppEvent(makeExtendedTextMessage('Extended text'));

    expect(event.message).toEqual({ type: 'text', body: 'Extended text' });
    expect(event.context?.isForwarded).toBe(true);
    expect(event.context?.isFrequentlyForwarded).toBe(true);
    expect(event.context?.forwardingScore).toBe(7);
    expect(event.context?.mentionedIds).toEqual(['34699000002@s.whatsapp.net']);
  });

  it('should map image message correctly', () => {
    const event = mapBaileysToWhatsAppEvent(makeImageMessage());

    expect(event.message.type).toBe('image');
    if (event.message.type === 'image') {
      expect(event.message.mimeType).toBe('image/jpeg');
      expect(event.message.caption).toBe('Check this photo');
      expect(event.message.fileSize).toBe(204800);
    }
  });

  it('should distinguish voice note from audio', () => {
    const voiceNote = mapBaileysToWhatsAppEvent(makeAudioMessage(true));
    const audio = mapBaileysToWhatsAppEvent(makeAudioMessage(false));

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

  it('should map video message correctly', () => {
    const event = mapBaileysToWhatsAppEvent(makeVideoMessage());

    expect(event.message.type).toBe('video');
    if (event.message.type === 'video') {
      expect(event.message.mimeType).toBe('video/mp4');
      expect(event.message.caption).toBe('Video content');
      expect(event.message.duration).toBe(30);
      expect(event.message.fileSize).toBe(5000000);
    }
  });

  it('should map document message correctly', () => {
    const event = mapBaileysToWhatsAppEvent(makeDocumentMessage());

    expect(event.message.type).toBe('document');
    if (event.message.type === 'document') {
      expect(event.message.mimeType).toBe('application/pdf');
      expect(event.message.fileName).toBe('report.pdf');
      expect(event.message.caption).toBe('Monthly report');
      expect(event.message.fileSize).toBe(1024000);
    }
  });

  it('should map location message correctly', () => {
    const event = mapBaileysToWhatsAppEvent(makeLocationMessage());

    expect(event.message.type).toBe('location');
    if (event.message.type === 'location') {
      expect(event.message.latitude).toBe(40.4168);
      expect(event.message.longitude).toBe(-3.7038);
      expect(event.message.name).toBe('Madrid');
      expect(event.message.address).toBe('Puerta del Sol, Madrid');
    }
  });

  it('should map sticker message correctly', () => {
    const event = mapBaileysToWhatsAppEvent(makeStickerMessage());

    expect(event.message.type).toBe('sticker');
    if (event.message.type === 'sticker') {
      expect(event.message.mimeType).toBe('image/webp');
      expect(event.message.isAnimated).toBe(true);
    }
  });

  it('should map contact message correctly', () => {
    const event = mapBaileysToWhatsAppEvent(makeContactMessage());

    expect(event.message.type).toBe('contact');
    if (event.message.type === 'contact') {
      expect(event.message.contacts).toHaveLength(1);
      expect(event.message.contacts[0]?.name.formatted).toBe('John Doe');
      expect(event.message.contacts[0]?.phones).toHaveLength(1);
      expect(event.message.contacts[0]?.phones[0]?.phone).toBe('+1234567890');
    }
  });

  it('should map reaction message correctly', () => {
    const event = mapBaileysToWhatsAppEvent(makeReactionMessage());

    expect(event.message.type).toBe('reaction');
    if (event.message.type === 'reaction') {
      expect(event.message.emoji).toBe('👍');
      expect(event.message.targetMessageId).toBe('BAILEYS_MSG_001');
    }
  });

  it('should map group message correctly', () => {
    const event = mapBaileysToWhatsAppEvent(makeGroupMessage());

    expect(event.chat.isGroup).toBe(true);
    expect(event.chat.chatId).toBe('120363001234567890@g.us');
    expect(event.from.wid).toBe('34699000001@s.whatsapp.net');
    expect(event.from.pushName).toBe('GroupMember');
    expect(event.message).toEqual({ type: 'text', body: 'Hello group!' });
  });

  it('should detect view-once messages', () => {
    const event = mapBaileysToWhatsAppEvent(makeViewOnceMessage());

    expect(event.context?.isViewOnce).toBe(true);
    expect(event.message.type).toBe('image');
  });

  it('should handle empty message gracefully', () => {
    const event = mapBaileysToWhatsAppEvent({
      key: {
        remoteJid: '34699000001@s.whatsapp.net',
        fromMe: false,
        id: 'BAILEYS_MSG_EMPTY',
      },
      message: null,
    });

    expect(event.message).toEqual({ type: 'text', body: '' });
  });
});

describe('mapWhatsAppEventToContentSummary (from Baileys events)', () => {
  it('should map text message summary', () => {
    const event = mapBaileysToWhatsAppEvent(makeTextMessage('Hello world'));
    const summary = mapWhatsAppEventToContentSummary(event.message);
    expect(summary.type).toBe('text');
    expect(summary.preview).toBe('Hello world');
    expect(summary.hasMedia).toBe(false);
  });

  it('should mark media messages correctly', () => {
    const imageEvent = mapBaileysToWhatsAppEvent(makeImageMessage());
    const imageSummary = mapWhatsAppEventToContentSummary(imageEvent.message);
    expect(imageSummary.type).toBe('image');
    expect(imageSummary.hasMedia).toBe(true);

    const audioEvent = mapBaileysToWhatsAppEvent(makeAudioMessage(true));
    const audioSummary = mapWhatsAppEventToContentSummary(audioEvent.message);
    expect(audioSummary.type).toBe('audio');
    expect(audioSummary.hasMedia).toBe(true);
  });

  it('should handle reaction message', () => {
    const event = mapBaileysToWhatsAppEvent(makeReactionMessage());
    const summary = mapWhatsAppEventToContentSummary(event.message);
    expect(summary.type).toBe('reaction');
    expect(summary.preview).toBe('👍');
    expect(summary.hasMedia).toBe(false);
  });
});

describe('buildWhatsAppEnvelope (from Baileys events)', () => {
  it('should build a complete unified envelope', () => {
    const event = mapBaileysToWhatsAppEvent(makeTextMessage('Test message'));
    const envelope = buildWhatsAppEnvelope(event, testAccount);

    expect(envelope.id).toMatch(/^msg_/);
    expect(envelope.accountId).toBe('wa-baileys-test');
    expect(envelope.channel).toBe('whatsapp');
    expect(envelope.direction).toBe('inbound');
    expect(envelope.conversationId).toBe('34699000001@s.whatsapp.net');
    expect(envelope.sender.id).toBe('34699000001@s.whatsapp.net');
    expect(envelope.sender.displayName).toBe('TestUser');
    expect(envelope.recipient.id).toBe('+34600000001');
    expect(envelope.contentSummary.type).toBe('text');
    expect(envelope.contentSummary.preview).toBe('Test message');
    expect(envelope.contentSummary.hasMedia).toBe(false);
    expect(envelope.channelPayload).toBe(event);
    expect(envelope.gateway.adapterId).toBe('baileys');
    expect(envelope.gateway.account.id).toBe('wa-baileys-test');
    expect(envelope.gateway.account.alias).toBe('Baileys Test');
    expect(envelope.gateway.account.owner).toBe('test-team');
    expect(envelope.gateway.account.tags).toEqual(['whatsapp', 'baileys', 'test']);
  });
});
