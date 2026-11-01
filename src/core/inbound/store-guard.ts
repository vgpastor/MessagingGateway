import { PermanentStoreError } from '../errors.js';
import { getLogger } from '../logger/logger.port.js';
import type { UnifiedEnvelope } from '../messaging/unified-envelope.js';
import type { InsertResult, MessageLogPort } from '../persistence/message-store.port.js';

/** Waits between attempts to store a message: 5 retries over about 30 s, inside the account's queue. */
export const PERSIST_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000];

/** How often a write of its own checks whether the message log is back, while the circuit is open. */
export const STORE_PROBE_INTERVAL_MS = 30_000;

/**
 * Failures of a live message that another attempt would not change, so it goes to the failed log at once.
 * Not a `TypeError`: a library may throw one for a lost connection.
 */
const isPermanentFailure = (err: unknown): boolean =>
  err instanceof PermanentStoreError || err instanceof RangeError;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export interface StoreGuardOptions {
  /** {@link PERSIST_RETRY_DELAYS_MS} by default. */
  retryDelaysMs?: readonly number[];
  /** {@link STORE_PROBE_INTERVAL_MS} by default. */
  probeIntervalMs?: number;
  /** The log answers again: time to store the failed log, and then call {@link StoreGuard.finishRecovery}. */
  onAnswering: () => void;
}

/** Why live messages are not reaching the log: it is down, or it is taking the failed log first. And the error they get. */
interface Diversion {
  phase: 'down' | 'recovering';
  cause: unknown;
}

/**
 * How the inbound path talks to the message log when it fails. A failure may pass, so a message
 * is retried inside its account's queue. A message that runs out of retries means the store is
 * down: the circuit opens, and from then on {@link insert} rejects at once instead of holding
 * every queue for half a minute per message. A write of its own every {@link STORE_PROBE_INTERVAL_MS}
 * tells when it is back: it depends on no message, so none can keep the circuit open, and an answer
 * alone is not enough. The message that opened it goes to the failed log like the rest.
 *
 * What is in the failed log arrived first. So when the probe writes the circuit does not close yet: it is
 * recovering, the failed log goes in through {@link insertOnce}, and live messages keep rejecting, to
 * queue up behind it, until {@link finishRecovery}. A failure during that opens the circuit again if the probe
 * fails too. If the probe writes, the store is taking messages and this one is not going in for now: it stays where
 * it is, safe, and nothing else stops. Nothing but an explicit `PermanentStoreError` gives up on a message.
 *
 * A failure of the message itself is not retried and opens nothing.
 */
export class StoreGuard {
  private diversion: Diversion | undefined;
  private probeTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  /** Wakes a message waiting for its next attempt. */
  private readonly retryWaits = new Set<() => void>();

  private get logger() {
    return getLogger().child({ module: 'store-guard' });
  }

  constructor(
    private readonly store: Pick<MessageLogPort, 'insertInbound' | 'probeWrite'>,
    private readonly options: StoreGuardOptions,
  ) {}

  /** Stores a live message, retrying what may pass. Rejects when it was not stored. */
  async insert(envelope: UnifiedEnvelope, raw: unknown): Promise<InsertResult> {
    const delays = this.options.retryDelaysMs ?? PERSIST_RETRY_DELAYS_MS;
    for (let attempt = 0; ; attempt++) {
      if (this.diversion) throw this.diversion.cause;
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
   * Stores a message of the failed log: one attempt, since it is safe where it is. It rejects when not stored, and
   * only a `PermanentStoreError` means never. A failure the probe confirms, right after, opens the circuit.
   */
  async insertOnce(envelope: UnifiedEnvelope, raw: unknown): Promise<InsertResult> {
    if (this.stopped) throw new Error('shutting down');
    if (this.diversion?.phase === 'down') throw this.diversion.cause;
    try {
      return await this.store.insertInbound(envelope, raw);
    } catch (err) {
      if (err instanceof PermanentStoreError) throw err;
      try {
        await this.store.probeWrite();
      } catch {
        this.open(err);
        throw err;
      }
      this.logger.error('A message of the failed log could not be stored with the message log working: it stays there', {
        accountId: envelope.accountId, messageId: envelope.id, error: errorMessage(err),
      });
      throw err;
    }
  }

  /** The failed log is being stored, and nothing has stopped it. */
  get recovering(): boolean {
    return !this.stopped && this.diversion?.phase === 'recovering';
  }

  /** A live message goes straight to the log. */
  get takingDirectly(): boolean {
    return !this.stopped && !this.diversion;
  }

  /** Live messages reach the log again. Does nothing if the recovery was cut short meanwhile. */
  finishRecovery(): void {
    if (!this.recovering) return;
    this.diversion = undefined;
    this.logger.info('Message log is back');
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
    if (this.diversion?.phase === 'down' || this.stopped) return;
    this.diversion = { phase: 'down', cause };
    this.logger.error('Message log is down: inbound messages go to the failed log until it is back', { error: errorMessage(cause) });
    this.wakeRetries();
    this.scheduleProbe();
  }

  private scheduleProbe(): void {
    this.probeTimer = setTimeout(() => void this.probe(), this.options.probeIntervalMs ?? STORE_PROBE_INTERVAL_MS);
    this.probeTimer.unref();
  }

  private async probe(): Promise<void> {
    if (this.diversion?.phase !== 'down') return;
    try {
      await this.store.probeWrite();
    } catch (err) {
      this.logger.warn('Message log still down', { error: errorMessage(err) });
      if (!this.stopped) this.scheduleProbe();
      return;
    }
    if (this.stopped) return;
    this.diversion = { phase: 'recovering', cause: new Error('the message log is taking the failed log first') };
    this.logger.info('Message log answers: storing the failed log before anything new');
    this.options.onAnswering();
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
