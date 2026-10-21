import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';

// Plain functions rather than vi.fn: vitest reports the rejected promise of a mock as an unhandled error.
const downloadCalls: unknown[][] = [];
let downloadImpl: (...args: unknown[]) => Promise<unknown> = async () => { throw new Error('unexpected download'); };
const downloadContentFromMessage = {
  reset() { downloadCalls.length = 0; downloadImpl = async () => { throw new Error('unexpected download'); }; },
  resolves(value: unknown) { downloadImpl = async () => value; },
  rejects(error: Error) { downloadImpl = async () => { throw error; }; },
  calls: downloadCalls,
};
vi.mock('@whiskeysockets/baileys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@whiskeysockets/baileys')>();
  return { ...actual, downloadContentFromMessage: (...args: unknown[]) => { downloadCalls.push(args); return downloadImpl(...args); } };
});

const { downloadBaileysMedia } = await import('../../../src/integrations/whatsapp/baileys/baileys-media.js');
const { toStorableRaw, restoreBaileysRaw } = await import('../../../src/integrations/whatsapp/baileys/baileys-storable-raw.js');
const { proto } = await import('@whiskeysockets/baileys');

const MAX = 1000;
const key = { remoteJid: '34600111222@s.whatsapp.net', id: 'ABC', fromMe: false };

function videoMsg(fileLength: unknown, extra: Record<string, unknown> = {}) {
  return {
    key,
    message: {
      videoMessage: {
        url: 'https://x', directPath: '/x', mimetype: 'video/mp4', mediaKey: Buffer.alloc(32, 2), fileLength, ...extra,
      },
    },
  } as never;
}

beforeEach(() => downloadContentFromMessage.reset());

describe('downloadBaileysMedia', () => {
  it('returns the downloaded bytes as a Buffer with mimetype and filename', async () => {
    downloadContentFromMessage.resolves(Readable.from([Buffer.from('ab'), Buffer.from('cd')]));

    const result = await downloadBaileysMedia(videoMsg(4, { fileName: 'clip.mp4' }), MAX);

    expect(result).toEqual({ data: Buffer.from('abcd'), mimeType: 'video/mp4', filename: 'clip.mp4' });
  });

  it('refuses by declared fileLength before downloading anything', async () => {
    const result = await downloadBaileysMedia(videoMsg(20_000_000), MAX);

    expect(result).toEqual({ skipped: 'too_large' });
    expect(downloadContentFromMessage.calls).toHaveLength(0);
  });

  it('understands fileLength as a numeric string (normalized raw) and as a Long', async () => {
    expect(await downloadBaileysMedia(videoMsg('20000000'), MAX)).toEqual({ skipped: 'too_large' });
    const long = proto.Message.VideoMessage.decode(proto.Message.VideoMessage.encode({ fileLength: 20_000_000 }).finish()).fileLength;
    expect(typeof long).toBe('object');
    expect(await downloadBaileysMedia(videoMsg(long), MAX)).toEqual({ skipped: 'too_large' });
    expect(downloadContentFromMessage.calls).toHaveLength(0);
  });

  it('aborts while streaming when the bytes exceed the cap even if fileLength lied', async () => {
    let destroyed = false;
    const stream = Readable.from((async function* () {
      yield Buffer.alloc(600);
      yield Buffer.alloc(600);
      yield Buffer.alloc(600);
    })());
    stream.on('close', () => { destroyed = true; });
    downloadContentFromMessage.resolves(stream);

    const result = await downloadBaileysMedia(videoMsg(10), MAX);

    expect(result).toEqual({ skipped: 'too_large' });
    await new Promise((r) => setImmediate(r));
    expect(destroyed).toBe(true);
  });

  it('enforces the cap while streaming when fileLength is missing', async () => {
    downloadContentFromMessage.resolves(Readable.from([Buffer.alloc(1500)]));

    expect(await downloadBaileysMedia(videoMsg(undefined), MAX)).toEqual({ skipped: 'too_large' });
  });

  it('returns undefined when the message has no downloadable media', async () => {
    const result = await downloadBaileysMedia({ key, message: { conversation: 'hi' } } as never, MAX);

    expect(result).toBeUndefined();
    expect(downloadContentFromMessage.calls).toHaveLength(0);
  });

  it('lets download errors propagate so the caller can record download_failed', async () => {
    downloadContentFromMessage.rejects(new Error('404 gone'));

    await expect(downloadBaileysMedia(videoMsg(10), MAX)).rejects.toThrow('404 gone');
  });
});

describe('restoreBaileysRaw', () => {
  it('rebuilds a downloadable message from the stored raw (buffers revived, long strings back to numbers)', async () => {
    const original = proto.WebMessageInfo.decode(proto.WebMessageInfo.encode({
      key,
      messageTimestamp: 1760900000,
      message: { imageMessage: { url: 'https://x', directPath: '/x', mimetype: 'image/jpeg', fileLength: 12345, mediaKey: Buffer.alloc(32, 7) } },
    }).finish());
    const stored = JSON.parse(JSON.stringify(toStorableRaw(original)));

    const restored = restoreBaileysRaw(stored);

    const image = restored.message?.imageMessage;
    expect(Buffer.from(image!.mediaKey!)).toEqual(Buffer.alloc(32, 7));
    expect(Number(image!.fileLength)).toBe(12345);

    downloadContentFromMessage.resolves(Readable.from([Buffer.from('xyz')]));
    const result = await downloadBaileysMedia(restored, 1_000_000);
    expect(result).toEqual({ data: Buffer.from('xyz'), mimeType: 'image/jpeg', filename: undefined });
    const [mediaArg, typeArg] = downloadContentFromMessage.calls[0]!;
    expect(Buffer.from((mediaArg as { mediaKey: Uint8Array }).mediaKey)).toEqual(Buffer.alloc(32, 7));
    expect(typeArg).toBe('image');
  });
});
