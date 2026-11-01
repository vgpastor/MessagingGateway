/** Port for metrics instrumentation — keeps connections layer decoupled from metric implementation */

export type MediaSkipReason = 'too_large' | 'download_failed';

/**
 * Why an inbound provider message was dropped before reaching the pipeline:
 * a placeholder for a message that failed to decrypt (the real one follows with the
 * same id), or a message with no content at all.
 */
export type InboundSkipReason = 'ciphertext_stub' | 'empty';

/** Why the conversation filter kept an inbound message out: not on the account's list, or a LID that could not be turned into a phone to look for it. */
export type InboundFilterReason = 'conversation_excluded' | 'lid_unresolved';

export interface MetricsPort {
  incCounter(name: string, labels?: Record<string, string>): void;
  decGauge(name: string, labels?: Record<string, string>): void;
  incGauge(name: string, labels?: Record<string, string>): void;
  observeHistogram(name: string, value: number, labels?: Record<string, string>): void;
  /** An inbound message did not reach the message log (refused, retries run out, or down), and went to the failed log */
  persistFailures(): void;
  /** Entries of the failed log that will never be stored went to the log of rejects */
  inboundRejected(count: number): void;
  failedLogHeld(count: number): void;
  /** An inbound media was not stored (over the size cap, or the download/write failed) */
  mediaSkipped(reason: MediaSkipReason): void;
  /** An inbound provider message was dropped before the pipeline (never logged nor emitted) */
  inboundSkipped(reason: InboundSkipReason): void;
  /** The conversation filter kept an inbound message out (never logged nor emitted) */
  inboundFiltered(reason: InboundFilterReason): void;
  /** An inbound message of `account` went through the pipeline; `ts` is seconds since epoch */
  lastInbound(account: string, ts: number): void;
}

/** No-op implementation for when metrics are disabled */
export const noopMetrics: MetricsPort = {
  incCounter: () => {},
  decGauge: () => {},
  incGauge: () => {},
  observeHistogram: () => {},
  persistFailures: () => {},
  inboundRejected: () => {},
  failedLogHeld: () => {},
  mediaSkipped: () => {},
  inboundSkipped: () => {},
  inboundFiltered: () => {},
  lastInbound: () => {},
};
