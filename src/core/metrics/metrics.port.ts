/** Port for metrics instrumentation — keeps connections layer decoupled from metric implementation */

export type MediaSkipReason = 'too_large' | 'download_failed';

/**
 * Why an inbound provider message was dropped before reaching the pipeline:
 * a placeholder for a message that failed to decrypt (the real one follows with the
 * same id), or a message with no content at all.
 */
export type InboundSkipReason = 'ciphertext_stub' | 'empty';

export interface MetricsPort {
  incCounter(name: string, labels?: Record<string, string>): void;
  decGauge(name: string, labels?: Record<string, string>): void;
  incGauge(name: string, labels?: Record<string, string>): void;
  observeHistogram(name: string, value: number, labels?: Record<string, string>): void;
  /** An inbound message could not be written to the message log */
  persistFailures(): void;
  /** An inbound media was not stored (over the size cap, or the download/write failed) */
  mediaSkipped(reason: MediaSkipReason): void;
  /** An inbound provider message was dropped before the pipeline (never logged nor emitted) */
  inboundSkipped(reason: InboundSkipReason): void;
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
  mediaSkipped: () => {},
  inboundSkipped: () => {},
  lastInbound: () => {},
};
