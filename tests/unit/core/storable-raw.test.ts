import { describe, it, expect } from 'vitest';
import { BufferJSON } from '@whiskeysockets/baileys';
import { toStorableRaw } from '../../../src/core/inbound/storable-raw.js';

const revive = (value: unknown) => JSON.parse(JSON.stringify(value), BufferJSON.reviver);

function imageMessage() {
  return {
    key: { remoteJid: '34600111222@s.whatsapp.net', id: 'ABC', fromMe: false },
    pushName: 'Ana',
    messageTimestamp: 1_700_000_000,
    message: {
      imageMessage: {
        url: 'https://mmg.whatsapp.net/o1/v/t62.7118-24/f1',
        directPath: '/o1/v/t62.7118-24/f1',
        mimetype: 'image/jpeg',
        mediaKey: Buffer.from('0123456789abcdef0123456789abcdef'),
        fileSha256: Buffer.alloc(32, 1),
        fileEncSha256: Buffer.alloc(32, 2),
        jpegThumbnail: Buffer.alloc(900, 7),
        thumbnailDirectPath: '/thumb',
        thumbnailSha256: Buffer.alloc(32, 3),
      },
    },
  };
}

describe('toStorableRaw', () => {
  it('removes thumbnails and other large binaries', () => {
    const out = JSON.stringify(toStorableRaw(imageMessage()));

    expect(out).not.toContain('jpegThumbnail');
    expect(out).not.toContain('thumbnailDirectPath');
    expect(out).not.toContain('thumbnailSha256');
  });

  it('strips streamingSidecar, waveform and pngThumbnail wherever they appear', () => {
    const msg = {
      message: {
        videoMessage: { streamingSidecar: Buffer.alloc(64), pngThumbnail: Buffer.alloc(64) },
        audioMessage: { waveform: Buffer.alloc(64), seconds: 3 },
      },
    };

    expect(toStorableRaw(msg)).toEqual({ message: { videoMessage: {}, audioMessage: { seconds: 3 } } });
  });

  it('keeps what is needed to download the media after a restart, revivable as Buffers', () => {
    const stored = toStorableRaw(imageMessage());
    const revived = revive(stored) as ReturnType<typeof imageMessage>;
    const image = revived.message.imageMessage;

    expect(image.url).toBe('https://mmg.whatsapp.net/o1/v/t62.7118-24/f1');
    expect(image.directPath).toBe('/o1/v/t62.7118-24/f1');
    expect(Buffer.isBuffer(image.mediaKey)).toBe(true);
    expect(image.mediaKey.equals(Buffer.from('0123456789abcdef0123456789abcdef'))).toBe(true);
    expect(image.fileSha256.equals(Buffer.alloc(32, 1))).toBe(true);
    expect(image.fileEncSha256.equals(Buffer.alloc(32, 2))).toBe(true);
  });

  it('drops any unknown binary larger than 1 KiB but keeps small ones', () => {
    const out = toStorableRaw({ big: Buffer.alloc(2048), bigU8: new Uint8Array(2048), small: Buffer.alloc(8, 5) });

    expect(out).not.toHaveProperty('big');
    expect(out).not.toHaveProperty('bigU8');
    expect(out).toHaveProperty('small');
  });

  it('returns plain JSON (no Buffers, no undefined) and does not mutate the input', () => {
    const msg = imageMessage();
    const out = toStorableRaw(msg);

    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
    expect(Buffer.isBuffer(msg.message.imageMessage.jpegThumbnail)).toBe(true);
    expect(Buffer.isBuffer(msg.message.imageMessage.mediaKey)).toBe(true);
  });
});
