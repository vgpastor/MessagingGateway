import type { UnifiedEnvelope } from '../messaging/unified-envelope.js';

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
