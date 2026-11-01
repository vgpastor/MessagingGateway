import type { UnifiedEnvelope } from '../messaging/unified-envelope.js';

/** An inbound message the message log would not take. `raw` is already in its storable form. */
export interface FailedInboundEntry {
  envelope: UnifiedEnvelope;
  raw: unknown;
}

/** Durable place for inbound messages that could not be stored, so they are not lost. */
export interface FailedInboundLog {
  append(entry: FailedInboundEntry): Promise<void>;

  /**
   * Hands every entry to `save`, in the order they were appended. An entry `save` accepts
   * leaves the log; one it rejects stays for the next time, and so does one that cannot be read.
   * Replays run one at a time, and {@link append} may run during one: what it adds waits for the next.
   */
  replay(save: (entry: FailedInboundEntry) => Promise<void>): Promise<{ saved: number; kept: number }>;
}
