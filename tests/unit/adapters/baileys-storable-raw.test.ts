import { describe, it, expect } from 'vitest';
import { BufferJSON, proto } from '@whiskeysockets/baileys';
import { toStorableRaw } from '../../../src/integrations/whatsapp/baileys/baileys-storable-raw.js';

const key = { remoteJid: '34600111222@s.whatsapp.net', id: 'ABC', fromMe: false };

const imageMessage = () => ({
  url: 'https://x',
  directPath: '/x',
  mimetype: 'image/jpeg',
  fileLength: 12345,
  mediaKey: Buffer.alloc(32, 2),
  fileSha256: Buffer.alloc(32, 3),
  fileEncSha256: Buffer.alloc(32, 4),
  jpegThumbnail: Buffer.alloc(2000, 1),
  thumbnailDirectPath: '/thumb',
  thumbnailSha256: Buffer.alloc(32, 5),
});

/** A message the way Baileys hands it over: decoded from the wire, i.e. real protobufjs instances. */
function decoded(message: proto.IMessage): proto.IWebMessageInfo {
  const bytes = proto.WebMessageInfo.encode({ key, messageTimestamp: 1760900000, message }).finish();
  return proto.WebMessageInfo.decode(bytes);
}

const revive = (value: unknown) => JSON.parse(JSON.stringify(value), BufferJSON.reviver);

describe('toStorableRaw (decoded protobuf messages)', () => {
  it('removes the thumbnail, also inside a quoted message', () => {
    const msg = decoded({
      imageMessage: imageMessage(),
      extendedTextMessage: {
        text: 'reply',
        contextInfo: { quotedMessage: { imageMessage: imageMessage() } },
      },
    });

    const out = JSON.stringify(toStorableRaw(msg));

    expect(out).not.toContain('jpegThumbnail');
    expect(out).not.toContain('thumbnailDirectPath');
    expect(out).not.toContain('thumbnailSha256');
    expect(out).toContain('"text":"reply"');
  });

  it('keeps what is needed to download the media after a restart, revivable as Buffers', () => {
    const stored = toStorableRaw(decoded({ imageMessage: imageMessage() }));
    const image = (revive(stored) as { message: { imageMessage: Record<string, unknown> } }).message.imageMessage;

    expect(image.url).toBe('https://x');
    expect(image.directPath).toBe('/x');
    expect(image.mimetype).toBe('image/jpeg');
    expect(Buffer.isBuffer(image.mediaKey)).toBe(true);
    expect((image.mediaKey as Buffer).byteLength).toBe(32);
    expect((image.mediaKey as Buffer).equals(Buffer.alloc(32, 2))).toBe(true);
    expect((image.fileSha256 as Buffer).equals(Buffer.alloc(32, 3))).toBe(true);
    expect((image.fileEncSha256 as Buffer).equals(Buffer.alloc(32, 4))).toBe(true);
  });

  it('stores longs as strings and keeps the key', () => {
    const stored = toStorableRaw(decoded({ imageMessage: imageMessage() })) as Record<string, any>;

    expect(stored.key).toMatchObject(key);
    expect(String(stored.messageTimestamp)).toBe('1760900000');
    expect(String(stored.message.imageMessage.fileLength)).toBe('12345');
  });

  it('strips streamingSidecar, waveform and pngThumbnail', () => {
    const stored = toStorableRaw(decoded({
      videoMessage: { streamingSidecar: Buffer.alloc(64, 1), mimetype: 'video/mp4' },
      audioMessage: { waveform: Buffer.alloc(64, 1), seconds: 3 },
      stickerMessage: { pngThumbnail: Buffer.alloc(64, 1), mimetype: 'image/webp' },
    })) as { message: Record<string, Record<string, unknown>> };

    expect(stored.message.videoMessage).toEqual({ mimetype: 'video/mp4' });
    expect(stored.message.audioMessage).toEqual({ seconds: 3 });
    expect(stored.message.stickerMessage).toEqual({ mimetype: 'image/webp' });
  });

  it('drops any other binary larger than 1 KiB', () => {
    const stored = toStorableRaw(decoded({
      imageMessage: { ...imageMessage(), firstScanSidecar: Buffer.alloc(2048, 9) },
    })) as { message: { imageMessage: Record<string, unknown> } };

    expect(stored.message.imageMessage).not.toHaveProperty('firstScanSidecar');
    expect(stored.message.imageMessage).toHaveProperty('mediaKey');
  });

  it('returns plain JSON and does not mutate the decoded message', () => {
    const msg = decoded({ imageMessage: imageMessage() });
    const out = toStorableRaw(msg);

    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
    expect(msg.message!.imageMessage!.jpegThumbnail).toHaveLength(2000);
  });

  it('falls back to a plain copy for input that is not a valid WebMessageInfo', () => {
    const stored = toStorableRaw({ key: 'weird', jpegThumbnail: Buffer.alloc(10), mediaKey: Buffer.alloc(32, 7) }) as Record<string, unknown>;
    const revived = revive(stored) as { key: string; mediaKey: Buffer };

    expect(stored).not.toHaveProperty('jpegThumbnail');
    expect(revived.key).toBe('weird');
    expect(Buffer.isBuffer(revived.mediaKey)).toBe(true);
  });
});
