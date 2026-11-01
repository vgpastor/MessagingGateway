import { describe, it, expect, vi } from 'vitest';
import { DiskMediaService, DOWNLOAD_RETRY_DELAYS_MS, type MediaDownload } from '../../../src/core/inbound/media-service.js';
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

function setup(download: MediaDownload, retry: readonly number[] = []) {
  const metrics = {
    incCounter: vi.fn(), decGauge: vi.fn(), incGauge: vi.fn(), observeHistogram: vi.fn(),
    persistFailures: vi.fn(), mediaSkipped: vi.fn(), inboundSkipped: vi.fn(), lastInbound: vi.fn(),
  };
  const store = {
    updateMedia: vi.fn().mockResolvedValue(undefined),
    findPendingMedia: vi.fn().mockResolvedValue([]),
    findById: vi.fn().mockResolvedValue(envelope()),
  };
  const files = { write: vi.fn().mockResolvedValue({ path: '/media/x.jpg', size: 10 }) };
  const restoreRaw = vi.fn((stored: unknown) => ({ restored: stored }));
  const service = new DiskMediaService({ store, files, download, restoreRaw, maxBytes: MAX, metrics, retryDelaysMs: retry });
  return { service, store, files, restoreRaw, metrics };
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

  it('counts every skipped media by reason', async () => {
    const tooLarge = setup(vi.fn<MediaDownload>().mockResolvedValue({ skipped: 'too_large' }));
    await tooLarge.service.process(envelope(), {});
    expect(tooLarge.metrics.mediaSkipped).toHaveBeenCalledWith('too_large');

    const failed = setup(vi.fn<MediaDownload>().mockRejectedValue(new Error('boom')));
    await failed.service.process(envelope(), {});
    expect(failed.metrics.mediaSkipped).toHaveBeenCalledTimes(1);
    expect(failed.metrics.mediaSkipped).toHaveBeenCalledWith('download_failed');
  });

  it('does not count a media that was already ready as skipped', async () => {
    const download = vi.fn<MediaDownload>().mockRejectedValue(new Error('late failure'));
    const { service, store, metrics } = setup(download);
    store.findById.mockResolvedValue({ ...envelope(), content: { type: 'image', media: { mimeType: 'image/jpeg', status: 'ready' } } });

    await service.process(envelope(), {});

    expect(metrics.mediaSkipped).not.toHaveBeenCalled();
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

describe('DiskMediaService when a download fails', () => {
  it('retries a transient failure: it ends up ready and is never recorded as skipped', async () => {
    const download = vi.fn<MediaDownload>()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValue({ data: Buffer.alloc(10), mimeType: 'image/jpeg' });
    const { service, store, metrics } = setup(download, [0, 0, 0]);

    await service.process(envelope(), {});

    expect(download).toHaveBeenCalledTimes(3);
    expect(store.updateMedia).toHaveBeenCalledTimes(1);
    expect(store.updateMedia).toHaveBeenCalledWith('MSG1', expect.objectContaining({ status: 'ready' }));
    expect(metrics.mediaSkipped).not.toHaveBeenCalled();
  });

  it('retries a failed write too', async () => {
    const download = vi.fn<MediaDownload>().mockResolvedValue({ data: Buffer.alloc(3), mimeType: 'image/png' });
    const { service, store, files } = setup(download, [0]);
    files.write.mockRejectedValueOnce(new Error('disk full'));

    await service.process(envelope(), {});

    expect(store.updateMedia).toHaveBeenCalledWith('MSG1', expect.objectContaining({ status: 'ready' }));
  });

  it('marks download_failed once, only when the retries run out', async () => {
    const download = vi.fn<MediaDownload>().mockRejectedValue(new Error('gone'));
    const { service, store, metrics } = setup(download, [0, 0]);

    await service.process(envelope(), {});

    expect(download).toHaveBeenCalledTimes(3);
    expect(store.updateMedia).toHaveBeenCalledTimes(1);
    expect(store.updateMedia).toHaveBeenCalledWith('MSG1', { status: 'skipped', skipReason: 'download_failed' });
    expect(metrics.mediaSkipped).toHaveBeenCalledTimes(1);
  });

  it('leaves the media pending while it waits for the next attempt, and waits the configured time', async () => {
    vi.useFakeTimers();
    try {
      const download = vi.fn<MediaDownload>()
        .mockRejectedValueOnce(new Error('blip'))
        .mockResolvedValue({ data: Buffer.alloc(1), mimeType: 'image/jpeg' });
      const { service, store } = setup(download, DOWNLOAD_RETRY_DELAYS_MS);

      const done = service.process(envelope(), {});
      await vi.advanceTimersByTimeAsync(DOWNLOAD_RETRY_DELAYS_MS[0]! - 1);
      expect(download).toHaveBeenCalledTimes(1);
      expect(store.updateMedia).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(download).toHaveBeenCalledTimes(2);
      expect(store.updateMedia).toHaveBeenCalledWith('MSG1', expect.objectContaining({ status: 'ready' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('a media waiting to retry does not hold a download slot', async () => {
    const download = vi.fn<MediaDownload>(async (raw) => {
      if ((raw as { id: string }).id === 'flaky' && download.mock.calls.length === 1) throw new Error('blip');
      return { data: Buffer.alloc(1), mimeType: 'image/jpeg' };
    });
    const store = {
      updateMedia: vi.fn().mockResolvedValue(undefined),
      findPendingMedia: vi.fn().mockResolvedValue([]),
      findById: vi.fn().mockResolvedValue(envelope()),
    };
    const service = new DiskMediaService({
      store, files: { write: vi.fn().mockResolvedValue({ path: 'x', size: 1 }) }, download, maxBytes: MAX, concurrency: 1, retryDelaysMs: [60_000],
    });

    void service.process(envelope('FLAKY'), { id: 'flaky' });
    await new Promise((r) => setImmediate(r));
    await service.process(envelope('NEXT'), { id: 'next' });

    expect(store.updateMedia).toHaveBeenCalledWith('NEXT', expect.objectContaining({ status: 'ready' }));
  });

  it('does not retry a stored raw that cannot be restored: that will not change', async () => {
    const download = vi.fn<MediaDownload>();
    const { service, store, restoreRaw } = setup(download, [0, 0]);
    store.findPendingMedia.mockResolvedValueOnce([{ id: 'BAD', accountId: 'wa-1', raw: 'garbage' }]).mockResolvedValue([]);
    restoreRaw.mockImplementation(() => { throw new Error('bad raw'); });

    await service.resumePendingMedia();

    expect(download).not.toHaveBeenCalled();
    expect(store.updateMedia).toHaveBeenCalledWith('BAD', { status: 'skipped', skipReason: 'download_failed' });
  });
});

describe('DiskMediaService concurrency and late failures', () => {
  it('a live process() and a resume on the same id download once and end up ready', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const download = vi.fn<MediaDownload>(async () => {
      await gate;
      return { data: Buffer.alloc(10), mimeType: 'image/jpeg' };
    });
    const { service, store, files } = setup(download);
    store.findPendingMedia.mockResolvedValueOnce([{ id: 'MSG1', accountId: 'wa-1', raw: {} }]).mockResolvedValue([]);

    const live = service.process(envelope('MSG1', 'wa-1'), {});
    const resumed = service.resumePendingMedia();
    await new Promise((r) => setImmediate(r));
    release();
    await Promise.all([live, resumed]);

    expect(download).toHaveBeenCalledTimes(1);
    expect(files.write).toHaveBeenCalledTimes(1);
    expect(store.updateMedia).toHaveBeenCalledTimes(1);
    expect(store.updateMedia).toHaveBeenCalledWith('MSG1', expect.objectContaining({ status: 'ready' }));
  });

  it('can process the same id again once the first run has finished', async () => {
    const download = vi.fn<MediaDownload>().mockResolvedValue({ data: Buffer.alloc(1), mimeType: 'image/jpeg' });
    const { service } = setup(download);

    await service.process(envelope(), {});
    await service.process(envelope(), {});

    expect(download).toHaveBeenCalledTimes(2);
  });

  it('a failure never overwrites a media that is already ready', async () => {
    const download = vi.fn<MediaDownload>().mockRejectedValue(new Error('late failure'));
    const { service, store } = setup(download);
    store.findById.mockResolvedValue({ ...envelope(), content: { type: 'image', media: { mimeType: 'image/jpeg', status: 'ready' } } });

    await service.process(envelope(), {});

    expect(store.updateMedia).not.toHaveBeenCalled();
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
