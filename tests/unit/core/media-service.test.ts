import { describe, it, expect, vi } from 'vitest';
import { DiskMediaService, type MediaDownload } from '../../../src/core/inbound/media-service.js';
import type { UnifiedEnvelope } from '../../../src/core/messaging/unified-envelope.js';

const MAX = 16_777_216;

function envelope(id = 'MSG1', accountId = 'wa-1'): UnifiedEnvelope {
  return {
    id,
    accountId,
    channel: 'whatsapp',
    direction: 'inbound',
    timestamp: new Date('2026-10-20T10:00:00Z'),
    conversationId: '34600000001@s.whatsapp.net',
    sender: { id: '34600000001@s.whatsapp.net' },
    recipient: { id: '+34600000099' },
    content: { type: 'image', media: { mimeType: 'image/jpeg', status: 'pending' } },
    gateway: {
      receivedAt: new Date('2026-10-20T10:00:00Z'),
      adapterId: 'baileys',
      account: { id: accountId, alias: 'a', owner: 'o', tags: [] },
    },
  } as UnifiedEnvelope;
}

function setup(download: MediaDownload) {
  const store = {
    updateMedia: vi.fn().mockResolvedValue(undefined),
    findPendingMedia: vi.fn().mockResolvedValue([]),
  };
  const files = { write: vi.fn().mockResolvedValue({ path: '/media/x.jpg', size: 10 }) };
  const restoreRaw = vi.fn((stored: unknown) => ({ restored: stored }));
  const service = new DiskMediaService({ store, files, download, restoreRaw, maxBytes: MAX });
  return { service, store, files, restoreRaw };
}

describe('DiskMediaService.process', () => {
  it('writes the file and marks the media ready', async () => {
    const download = vi.fn<MediaDownload>().mockResolvedValue({ data: Buffer.alloc(10, 1), mimeType: 'image/jpeg' });
    const { service, store, files } = setup(download);

    await service.process(envelope('MSG1', 'wa-1'), { raw: true });

    expect(download).toHaveBeenCalledWith({ raw: true }, MAX);
    expect(files.write).toHaveBeenCalledWith('wa-1', 'MSG1', 'jpg', expect.any(Buffer));
    expect(store.updateMedia).toHaveBeenCalledWith('MSG1', { status: 'ready', size: 10, url: '/api/v1/media/MSG1' });
  });

  it('skips as too_large when the downloader refuses the file, without writing', async () => {
    const download = vi.fn<MediaDownload>().mockResolvedValue({ skipped: 'too_large' });
    const { service, store, files } = setup(download);

    await service.process(envelope(), {});

    expect(files.write).not.toHaveBeenCalled();
    expect(store.updateMedia).toHaveBeenCalledWith('MSG1', { status: 'skipped', skipReason: 'too_large' });
  });

  it('marks download_failed when the download throws', async () => {
    const download = vi.fn<MediaDownload>().mockRejectedValue(new Error('boom'));
    const { service, store, files } = setup(download);

    await expect(service.process(envelope(), {})).resolves.toBeUndefined();

    expect(files.write).not.toHaveBeenCalled();
    expect(store.updateMedia).toHaveBeenCalledWith('MSG1', { status: 'skipped', skipReason: 'download_failed' });
  });

  it('marks download_failed when writing the file fails', async () => {
    const download = vi.fn<MediaDownload>().mockResolvedValue({ data: Buffer.alloc(3), mimeType: 'image/png' });
    const { service, store, files } = setup(download);
    files.write.mockRejectedValue(new Error('disk full'));

    await service.process(envelope(), {});

    expect(store.updateMedia).toHaveBeenCalledWith('MSG1', { status: 'skipped', skipReason: 'download_failed' });
  });

  it('marks download_failed when the message carries nothing downloadable', async () => {
    const download = vi.fn<MediaDownload>().mockResolvedValue(undefined);
    const { service, store } = setup(download);

    await service.process(envelope(), {});

    expect(store.updateMedia).toHaveBeenCalledWith('MSG1', { status: 'skipped', skipReason: 'download_failed' });
  });

  it('never throws, even when recording the failure fails', async () => {
    const download = vi.fn<MediaDownload>().mockRejectedValue(new Error('boom'));
    const { service, store } = setup(download);
    store.updateMedia.mockRejectedValue(new Error('db down'));

    await expect(service.process(envelope(), {})).resolves.toBeUndefined();
  });
});

describe('DiskMediaService.resumePendingMedia', () => {
  it('processes every pending row, restoring the stored raw before downloading', async () => {
    const download = vi.fn<MediaDownload>().mockResolvedValue({ data: Buffer.alloc(10), mimeType: 'video/mp4' });
    const { service, store, files, restoreRaw } = setup(download);
    store.findPendingMedia.mockResolvedValueOnce([
      { id: 'A', accountId: 'wa-1', raw: { n: 1 } },
      { id: 'B', accountId: 'wa-2', raw: { n: 2 } },
    ]).mockResolvedValue([]);

    const count = await service.resumePendingMedia();

    expect(count).toBe(2);
    expect(restoreRaw).toHaveBeenCalledTimes(2);
    expect(download).toHaveBeenCalledWith({ restored: { n: 1 } }, MAX);
    expect(files.write).toHaveBeenCalledWith('wa-1', 'A', 'mp4', expect.any(Buffer));
    expect(files.write).toHaveBeenCalledWith('wa-2', 'B', 'mp4', expect.any(Buffer));
    expect(store.updateMedia).toHaveBeenCalledWith('A', expect.objectContaining({ status: 'ready' }));
    expect(store.updateMedia).toHaveBeenCalledWith('B', expect.objectContaining({ status: 'ready' }));
  });

  it('marks a row failed when its stored raw cannot be restored, and carries on', async () => {
    const download = vi.fn<MediaDownload>().mockResolvedValue({ data: Buffer.alloc(1), mimeType: 'image/jpeg' });
    const { service, store, restoreRaw } = setup(download);
    store.findPendingMedia.mockResolvedValueOnce([
      { id: 'BAD', accountId: 'wa-1', raw: 'garbage' },
      { id: 'OK', accountId: 'wa-1', raw: {} },
    ]).mockResolvedValue([]);
    restoreRaw.mockImplementationOnce(() => { throw new Error('bad raw'); });

    await service.resumePendingMedia();

    expect(store.updateMedia).toHaveBeenCalledWith('BAD', { status: 'skipped', skipReason: 'download_failed' });
    expect(store.updateMedia).toHaveBeenCalledWith('OK', expect.objectContaining({ status: 'ready' }));
  });

  it('does not loop forever on rows that stay pending', async () => {
    const download = vi.fn<MediaDownload>().mockResolvedValue({ data: Buffer.alloc(1), mimeType: 'image/jpeg' });
    const { service, store } = setup(download);
    store.findPendingMedia.mockResolvedValue([{ id: 'A', accountId: 'wa-1', raw: {} }]);
    store.updateMedia.mockRejectedValue(new Error('db down'));

    const count = await service.resumePendingMedia();

    expect(count).toBe(1);
  });

  it('returns 0 when nothing is pending', async () => {
    const { service } = setup(vi.fn<MediaDownload>());
    expect(await service.resumePendingMedia()).toBe(0);
  });
});
