import { getLogger } from '../logger/logger.port.js';
import { extensionForMimeType } from '../messaging/media-mime.js';
import type { UnifiedEnvelope } from '../messaging/unified-envelope.js';
import { noopMetrics, type MetricsPort } from '../metrics/metrics.port.js';
import type { MessageLogPort, MessageStorePort } from '../persistence/message-store.port.js';

/**
 * Downloads and stores the media of inbound messages, off the hot path: the
 * message is already persisted and emitted (with `media.status = 'pending'`)
 * by the time {@link MediaService.process} runs.
 */
export interface MediaService {
  /** Download the media of a just-received message. Must not throw: failures are recorded on the media itself. */
  process(envelope: UnifiedEnvelope, raw: unknown): Promise<void>;
  /** Resume media left `pending` by a previous run. Returns how many were picked up. */
  resumePendingMedia(): Promise<number>;
}

/** Does nothing: media stays `pending`. Used until a real implementation is wired. */
export const noopMediaService: MediaService = {
  process: async () => {},
  resumePendingMedia: async () => 0,
};

/** Bytes of a downloaded media. */
export interface DownloadedMedia {
  data: Buffer;
  mimeType: string;
  filename?: string;
}

/**
 * Fetches the media of a provider message. Resolves to `{ skipped: 'too_large' }`
 * when it exceeds `maxBytes` (checked before and while downloading), to `undefined`
 * when the message has nothing downloadable, and rejects when the download fails.
 */
export type MediaDownload = (raw: unknown, maxBytes: number) => Promise<DownloadedMedia | { skipped: 'too_large' } | undefined>;

/** Where downloaded media is written. */
export interface MediaFileWriter {
  write(accountId: string, mediaId: string, ext: string, data: Buffer): Promise<{ path: string; size: number }>;
}

/** Where stored media is read from. Passing the owning `accountId` narrows the lookup. */
export interface MediaFileReader {
  open(mediaId: string, accountId?: string): Promise<{ stream: NodeJS.ReadableStream; size: number; mimeType: string } | undefined>;
}

export interface DiskMediaServiceDeps {
  store: Pick<MessageLogPort, 'updateMedia' | 'findPendingMedia'> & Pick<MessageStorePort, 'findById'>;
  files: MediaFileWriter;
  download: MediaDownload;
  /** Turns the raw payload kept in the message log back into what `download` expects (revives buffers...). Identity by default. */
  restoreRaw?: (stored: unknown) => unknown;
  maxBytes: number;
  /** Downloads running at once (each can hold up to `maxBytes` in memory). Default 4. */
  concurrency?: number;
  /** Rows fetched per page when resuming. Default 100. */
  resumeBatchSize?: number;
  /** Waits between attempts to store a media. {@link DOWNLOAD_RETRY_DELAYS_MS} by default. */
  retryDelaysMs?: readonly number[];
  /** Counts skipped media. No-op by default. */
  metrics?: MetricsPort;
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_RESUME_BATCH = 100;

/**
 * A failed download is often a network or CDN hiccup: it only becomes final after these waits
 * (about 13 minutes). Meanwhile the media stays `pending`, so a restart picks it up again.
 */
export const DOWNLOAD_RETRY_DELAYS_MS: readonly number[] = [5_000, 30_000, 120_000, 600_000];

export const mediaUrl = (mediaId: string): string => `/api/v1/media/${mediaId}`;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Stores inbound media on disk and records the outcome on the message
 * (`ready` + `url`, or `skipped` + reason). The envelope id is the media id.
 */
export class DiskMediaService implements MediaService {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  /** Media ids being processed right now: the live path and a resume must not both work on one id. */
  private readonly inFlight = new Set<string>();

  private get logger() {
    return getLogger().child({ module: 'media-service' });
  }

  constructor(private readonly deps: DiskMediaServiceDeps) {}

  async process(envelope: UnifiedEnvelope, raw: unknown): Promise<void> {
    await this.run(envelope.id, envelope.accountId, () => raw);
  }

  async resumePendingMedia(): Promise<number> {
    const batchSize = this.deps.resumeBatchSize ?? DEFAULT_RESUME_BATCH;
    const seen = new Set<string>();
    let picked = 0;
    for (;;) {
      const batch = (await this.deps.store.findPendingMedia(batchSize)).filter((row) => !seen.has(row.id));
      if (batch.length === 0) break;
      for (const row of batch) seen.add(row.id);
      picked += batch.length;
      await Promise.all(batch.map((row) => this.run(row.id, row.accountId, () => (this.deps.restoreRaw ?? ((v) => v))(row.raw))));
    }
    if (picked > 0) this.logger.info('Resumed pending media', { count: picked });
    return picked;
  }

  /** `getRaw` runs inside the guard: a stored raw that cannot be restored fails that media only, and for good. */
  private async run(mediaId: string, accountId: string, getRaw: () => unknown): Promise<void> {
    if (this.inFlight.has(mediaId)) return;
    this.inFlight.add(mediaId);
    try {
      let raw: unknown;
      try {
        raw = getRaw();
      } catch (err) {
        this.logger.warn('Stored raw message cannot be restored', { accountId, mediaId, error: errorMessage(err) });
        await this.markSkipped(mediaId, accountId, 'download_failed');
        return;
      }
      await this.storeWithRetries(mediaId, accountId, raw);
    } finally {
      this.inFlight.delete(mediaId);
    }
  }

  /** The download slot is only held during an attempt: a media waiting to retry blocks no other. */
  private async storeWithRetries(mediaId: string, accountId: string, raw: unknown): Promise<void> {
    const delays = this.deps.retryDelaysMs ?? DOWNLOAD_RETRY_DELAYS_MS;
    for (let attempt = 0; ; attempt++) {
      const delay = delays[attempt];
      await this.acquire();
      try {
        await this.store(mediaId, accountId, raw);
        return;
      } catch (err) {
        this.logger.warn('Media download failed', { accountId, mediaId, attempt: attempt + 1, retryInMs: delay, error: errorMessage(err) });
        if (delay === undefined) {
          await this.markSkipped(mediaId, accountId, 'download_failed');
          return;
        }
      } finally {
        this.release();
      }
      await new Promise((resolve) => { setTimeout(resolve, delay).unref(); });
    }
  }

  private async store(mediaId: string, accountId: string, raw: unknown): Promise<void> {
    const result = await this.deps.download(raw, this.deps.maxBytes);
    if (!result) {
      this.logger.warn('Message has no downloadable media', { accountId, mediaId });
      await this.markSkipped(mediaId, accountId, 'download_failed', true);
      return;
    }
    if ('skipped' in result) {
      this.logger.info('Media skipped: over the size cap', { accountId, mediaId, maxBytes: this.deps.maxBytes });
      await this.markSkipped(mediaId, accountId, result.skipped, true);
      return;
    }
    const { size } = await this.deps.files.write(accountId, mediaId, extensionForMimeType(result.mimeType), result.data);
    await this.deps.store.updateMedia(mediaId, { status: 'ready', size, url: mediaUrl(mediaId) });
  }

  /**
   * Records that the media was not stored, unless it already is: a late failure
   * (e.g. a second attempt) must never turn a `ready` media into `skipped`.
   * With `propagate` a storage error is rethrown (the caller's catch records it);
   * otherwise it is only logged.
   */
  private async markSkipped(
    mediaId: string, accountId: string, skipReason: 'too_large' | 'download_failed', propagate = false,
  ): Promise<void> {
    try {
      const current = await this.deps.store.findById(mediaId);
      const status = current && 'media' in current.content ? current.content.media?.status : undefined;
      if (status === 'ready') return;
      await this.deps.store.updateMedia(mediaId, { status: 'skipped', skipReason });
      (this.deps.metrics ?? noopMetrics).mediaSkipped(skipReason);
    } catch (err) {
      if (propagate) throw err;
      this.logger.error('Failed to record media failure', { accountId, mediaId, error: errorMessage(err) });
    }
  }

  private acquire(): Promise<void> {
    if (this.active < (this.deps.concurrency ?? DEFAULT_CONCURRENCY)) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next(); // the slot passes straight to the next waiter
    else this.active--;
  }
}
