import { getLogger } from '../logger/logger.port.js';
import type { MessageLogPort } from '../persistence/message-store.port.js';

/** How often the retention job runs once started. */
export const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Removes stored media files older than `days`; resolves to the id of every media removed. */
export interface MediaPurger {
  purgeOlderThan(days: number): Promise<string[]>;
}

export interface RetentionDeps {
  messages: Pick<MessageLogPort, 'deleteOlderThan' | 'updateMedia'>;
  media: MediaPurger;
  /** Days a message row is kept. 0 (or negative) disables text retention: nothing is deleted. */
  messageRetentionDays: number;
  /** Days a media file is kept. 0 (or negative) disables media retention: no file is removed. */
  mediaRetentionDays: number;
}

export interface RetentionResult {
  /** Message rows deleted */
  messages: number;
  /** Media files removed (their messages are kept, with media marked `expired`) */
  media: number;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * One retention pass: media files past `mediaRetentionDays` are removed and their
 * messages' media marked `expired`; messages past `messageRetentionDays` are deleted.
 * The two steps are independent: a failure in one is logged and does not stop the other.
 */
export async function runRetention(deps: RetentionDeps): Promise<RetentionResult> {
  const logger = getLogger().child({ module: 'retention' });
  const result: RetentionResult = { messages: 0, media: 0 };

  if (deps.mediaRetentionDays > 0) {
    try {
      const purged = await deps.media.purgeOlderThan(deps.mediaRetentionDays);
      result.media = purged.length;
      for (const mediaId of purged) {
        try {
          await deps.messages.updateMedia(mediaId, { status: 'expired' });
        } catch (err) {
          // The row keeps saying `ready`, but the media endpoint already answers 410 for a missing file.
          logger.warn('Failed to mark purged media as expired', { mediaId, error: errorMessage(err) });
        }
      }
    } catch (err) {
      logger.error('Media retention failed', { error: errorMessage(err) });
    }
  }

  if (deps.messageRetentionDays > 0) {
    try {
      result.messages = await deps.messages.deleteOlderThan(deps.messageRetentionDays);
    } catch (err) {
      logger.error('Message retention failed', { error: errorMessage(err) });
    }
  }

  if (result.messages > 0 || result.media > 0) logger.info('Retention pass finished', { ...result });
  return result;
}

export interface RetentionSchedule {
  stop(): void;
}

/**
 * Runs {@link runRetention} right away (without blocking the caller) and then every 24 hours.
 * A pass never throws, and a tick is skipped while the previous pass is still running.
 * The timer is unref'd, so it never keeps the process alive.
 */
export function startRetentionSchedule(deps: RetentionDeps, intervalMs: number = RETENTION_INTERVAL_MS): RetentionSchedule {
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await runRetention(deps);
    } catch (err) {
      getLogger().error('Retention pass crashed', { error: errorMessage(err) });
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
