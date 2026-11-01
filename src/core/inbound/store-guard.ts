import { PermanentStoreError } from '../errors.js';
import { getLogger } from '../logger/logger.port.js';
import type { UnifiedEnvelope } from '../messaging/unified-envelope.js';
import type { InsertResult, MessageLogPort } from '../persistence/message-store.port.js';

/** Waits between attempts to store a message: 5 retries over about 30 s, inside the account's queue. */
export const PERSIST_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000];

/** How often a ping checks whether the message log is back, while the circuit is open. */
export const STORE_PROBE_INTERVAL_MS = 30_000;

/** Failures that say something about the message, not about the store: another attempt would end the same. */
const isPermanentFailure = (err: unknown): boolean =>
  err instanceof PermanentStoreError || err instanceof TypeError || err instanceof RangeError;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A permanent failure as the failed log understands it. */
const asRefusal = (err: unknown): PermanentStoreError =>
  (err instanceof PermanentStoreError ? err : new PermanentStoreError(errorMessage(err), { cause: err }));

export interface StoreGuardOptions {
  /** {@link PERSIST_RETRY_DELAYS_MS} by default. */
  retryDelaysMs?: readonly number[];
  /** {@link STORE_PROBE_INTERVAL_MS} by default. */
  probeIntervalMs?: number;
  /** The circuit closed: the log takes messages again. */
  onRecovered: () => void;
}

/** The outage in course: the error every message gets until it is over. */
interface Outage {
  cause: unknown;
}

/**
 * How the inbound path talks to the message log when it fails. A failure may pass, so a message
 * is retried inside its account's queue. A message that runs out of retries means the store is
 * down: the circuit opens, and from then on {@link insert} rejects at once instead of holding
 * every queue for half a minute per message. A ping every {@link STORE_PROBE_INTERVAL_MS} closes
 * it: it depends on no message, so none can keep the circuit open. The message that opened it goes
 * to the failed log like the rest.
 *
 * A failure of the message itself is not retried and opens nothing.
 */
export class StoreGuard {
  private outage: Outage | undefined;
  private probeTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  /** Wakes a message waiting for its next attempt. */
  private readonly retryWaits = new Set<() => void>();

  private get logger() {
    return getLogger().child({ module: 'store-guard' });
  }

  constructor(
    private readonly store: Pick<MessageLogPort, 'insertInbound' | 'ping'>,
    private readonly options: StoreGuardOptions,
  ) {}

  /** Stores a live message, retrying what may pass. Rejects when it was not stored. */
  async insert(envelope: UnifiedEnvelope, raw: unknown): Promise<InsertResult> {
    const delays = this.options.retryDelaysMs ?? PERSIST_RETRY_DELAYS_MS;
    for (let attempt = 0; ; attempt++) {
      if (this.outage) throw this.outage.cause;
      try {
        const result = await this.store.insertInbound(envelope, raw);
        return attempt > 0 ? this.settleRetried(envelope, result) : result;
      } catch (err) {
        if (isPermanentFailure(err)) throw err;
        const delay = delays[attempt];
        if (delay === undefined) {
          this.open(err);
          throw err;
        }
        if (this.stopped) throw err;
        this.logger.warn('Failed to persist inbound message, retrying', {
          accountId: envelope.accountId, messageId: envelope.id, attempt: attempt + 1, delayMs: delay, error: errorMessage(err),
        });
        await this.waitToRetry(delay);
      }
    }
  }

  /**
   * Stores a message of the failed log: one attempt, since it is safe where it is. A store that is down opens
   * the circuit; a failure that is the message's rejects with a `PermanentStoreError`.
   */
  async insertOnce(envelope: UnifiedEnvelope, raw: unknown): Promise<InsertResult> {
    if (this.outage) throw this.outage.cause;
    try {
      return await this.store.insertInbound(envelope, raw);
    } catch (err) {
      if (isPermanentFailure(err)) throw asRefusal(err);
      this.open(err);
      throw err;
    }
  }

  /** For shutdown: nobody waits between attempts any more, and the store is not probed again. */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.probeTimer);
    this.wakeRetries();
  }

  /**
   * A duplicate after a failed attempt can be that very attempt: its COMMIT went through and only the answer
   * was lost. Then the message is stored, under the number it got. A row of another envelope is a real duplicate.
   */
  private settleRetried(envelope: UnifiedEnvelope, result: InsertResult): InsertResult {
    if (result.inserted || result.storedId !== envelope.id) return result;
    return { inserted: true, seq: result.seq, accountSeq: result.accountSeq };
  }

  private open(cause: unknown): void {
    if (this.outage || this.stopped) return;
    this.outage = { cause };
    this.logger.error('Message log is down: inbound messages go to the failed log until it is back', { error: errorMessage(cause) });
    this.wakeRetries();
    this.scheduleProbe();
  }

  private scheduleProbe(): void {
    this.probeTimer = setTimeout(() => void this.probe(), this.options.probeIntervalMs ?? STORE_PROBE_INTERVAL_MS);
    this.probeTimer.unref();
  }

  private async probe(): Promise<void> {
    if (!this.outage) return;
    try {
      await this.store.ping();
    } catch (err) {
      this.logger.warn('Message log still down', { error: errorMessage(err) });
      if (!this.stopped) this.scheduleProbe();
      return;
    }
    if (this.stopped) return;
    this.outage = undefined;
    this.logger.info('Message log is back');
    this.options.onRecovered();
  }

  private waitToRetry(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.retryWaits.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, delayMs);
      this.retryWaits.add(wake);
    });
  }

  private wakeRetries(): void {
    for (const wake of this.retryWaits) wake();
  }
}
