import type { UnifiedEnvelope } from '../messaging/unified-envelope.js';

/** An inbound message the message log would not take. `raw` is already in its storable form. */
export interface FailedInboundEntry {
  envelope: UnifiedEnvelope;
  raw: unknown;
}

/** What became of the entries of a replay. */
export interface FailedInboundReplay {
  /** `save` accepted them, and they left the log. */
  saved: number;
  /** They stay for the next time. */
  kept: number;
  /** They will never get in, and left the log for good. */
  rejected: number;
}

/** Durable place for inbound messages that could not be stored, so they are not lost. */
export interface FailedInboundLog {
  append(entry: FailedInboundEntry): Promise<void>;

  /**
   * Hands every entry to `save`, in the order they were appended. An entry `save` accepts leaves the log. One it
   * rejects with a `PermanentStoreError`, or a line that cannot be read, goes to a log of rejects that nothing reads
   * back. One it rejects with anything else stays for the next time.
   * Replays run one at a time, and {@link append} may run during one: what it adds waits for the next.
   */
  replay(save: (entry: FailedInboundEntry) => Promise<void>): Promise<FailedInboundReplay>;
}
