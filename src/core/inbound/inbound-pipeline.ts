import type { ChannelAccount } from '../accounts/channel-account.js';
import type { EventBus } from '../event-bus.js';
import { Events, createEvent } from '../events.js';
import type { MessageInboundPayload } from '../events.js';
import { getLogger } from '../logger/logger.port.js';
import type { MediaInfo } from '../messaging/content.js';
import type { UnifiedEnvelope } from '../messaging/unified-envelope.js';
import type { MetricsPort } from '../metrics/metrics.port.js';
import type { InsertResult, MessageLogPort } from '../persistence/message-store.port.js';
import type { FailedInboundLog } from './failed-inbound-log.js';
import type { MediaService } from './media-service.js';

/** Waits between attempts to store a message: 5 retries over about 30 s, inside the account's queue. */
export const PERSIST_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000];

export interface InboundPipelineDeps {
  /** Message log. Undefined when storage is disabled: messages are then emitted without a sequence. */
  store?: MessageLogPort;
  /** Where a message goes when the log will not take it, to be stored at the next start. */
  failedLog?: FailedInboundLog;
  eventBus: EventBus;
  media: MediaService;
  metrics: MetricsPort;
  /** Resolves a WhatsApp LID to its phone JID (`digits[:device]@s.whatsapp.net`) or bare number. */
  resolveLidToPhone?: (accountId: string, lid: string) => Promise<string | undefined>;
  /** Turns the provider's raw message into something storable as JSON (strip binaries...). Identity by default. */
  toStorableRaw?: (raw: unknown) => unknown;
  /** {@link PERSIST_RETRY_DELAYS_MS} by default. */
  persistRetryDelaysMs?: readonly number[];
}

interface InboundMessage {
  account: ChannelAccount;
  envelope: UnifiedEnvelope;
  raw: unknown;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Single entry point for inbound messages: filter → persist → emit → media.
 *
 * Persisting strictly before emitting is what makes `accountSeq` trustworthy:
 * a consumer that sees a gap knows a message was lost, so no event may carry a
 * sequence that is not yet in the log. A duplicate (already logged) is neither
 * emitted nor reprocessed.
 *
 * Messages of the same account are stored one at a time, in the order they
 * reach {@link handle}: the log assigns `accountSeq` in insert order. Their event
 * handlers start in that same order, but the queue never waits for them: storing
 * must not depend on how fast a subscriber is. Accounts do not block each other.
 *
 * A store failure is retried inside the queue. When the retries run out the message
 * goes to the failed log, which is stored at the next start ({@link replayFailed}),
 * and is still delivered live, without a sequence.
 */
export class InboundPipeline {
  private get logger() {
    return getLogger().child({ module: 'inbound-pipeline' });
  }

  /** Tail of each account's queue; it never rejects, so one failure cannot break the chain. */
  private readonly queues = new Map<string, Promise<void>>();
  /** Accepted by {@link handle} and neither stored nor written off yet: what a shutdown must not lose. */
  private readonly unsaved = new Set<InboundMessage>();
  /** Wakes a message waiting for its next attempt. */
  private readonly retryWaits = new Set<() => void>();
  private draining = false;

  constructor(private readonly deps: InboundPipelineDeps) {}

  handle(account: ChannelAccount, envelope: UnifiedEnvelope, raw: unknown): Promise<void> {
    const message: InboundMessage = { account, envelope, raw };
    this.unsaved.add(message);
    const previous = this.queues.get(account.id) ?? Promise.resolve();
    const run = previous.then(() => this.process(message));
    const tail = run.catch((err) => {
      this.logger.error('Inbound message processing failed', {
        accountId: account.id, messageId: envelope.id, error: errorMessage(err),
      });
    });
    this.queues.set(account.id, tail);
    void tail.then(() => {
      if (this.queues.get(account.id) === tail) this.queues.delete(account.id);
    });
    return run;
  }

  /**
   * Stores what a previous run left in the failed log. Call it before connecting accounts, so
   * these messages take their `accountSeq` ahead of new ones. They were already delivered live
   * (or a consumer gets them from the log through the gap), so nothing is emitted again; the
   * media they left `pending` is picked up by {@link MediaService.resumePendingMedia}.
   */
  async replayFailed(): Promise<void> {
    const { store, failedLog } = this.deps;
    if (!store || !failedLog) return;
    const { saved, kept } = await failedLog.replay(async ({ envelope, raw }) => {
      await store.insertInbound(envelope, raw);
    });
    if (saved > 0) this.logger.info('Stored inbound messages from the failed log', { saved });
    if (kept > 0) this.logger.error('Inbound messages remain in the failed log', { kept });
  }

  /**
   * For shutdown: stops waiting between attempts, gives the queues up to `timeoutMs`,
   * and writes off to the failed log whatever is still not stored by then.
   */
  async drain(timeoutMs: number): Promise<void> {
    this.draining = true;
    for (const wake of this.retryWaits) wake();

    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(this.queues.values()),
      new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
    clearTimeout(timer);

    const left = [...this.unsaved];
    this.unsaved.clear();
    for (const { account, envelope, raw } of left) {
      try {
        if (!this.accepts(account, envelope)) continue;
        this.markMediaPending(envelope);
        await this.writeOff(envelope, this.storableRaw(raw), new Error('shutting down'));
      } catch (err) {
        this.logger.error('Failed to write off inbound message', { accountId: account.id, messageId: envelope.id, error: errorMessage(err) });
      }
    }
  }

  private async process(message: InboundMessage): Promise<void> {
    if (!this.unsaved.has(message)) return; // already written off by drain()
    const { account, envelope, raw } = message;
    try {
      if (!this.accepts(account, envelope)) return;

      await this.resolveSenderPhone(envelope);
      const media = this.markMediaPending(envelope);

      if (!(await this.persist(message))) return;

      this.deps.metrics.lastInbound(account.id, Math.floor(Date.now() / 1000));
      this.emit(account, envelope);

      if (media) this.scheduleMedia(envelope, raw);
    } finally {
      this.unsaved.delete(message);
    }
  }

  private accepts(account: ChannelAccount, envelope: UnifiedEnvelope): boolean {
    const allowed = account.conversations;
    return allowed === undefined || allowed === '*' || allowed.includes(envelope.conversationId);
  }

  /** WhatsApp sometimes identifies a sender by LID only; the phone is what consumers match on. */
  private async resolveSenderPhone(envelope: UnifiedEnvelope): Promise<void> {
    const { sender } = envelope;
    if (sender.phone || !sender.lid || !this.deps.resolveLidToPhone) return;
    try {
      const resolved = await this.deps.resolveLidToPhone(envelope.accountId, sender.lid);
      const digits = resolved?.split('@')[0]?.split(':')[0]?.replace(/\D/g, '');
      if (digits) sender.phone = `+${digits}`;
    } catch (err) {
      this.logger.warn('Failed to resolve sender LID to phone', {
        accountId: envelope.accountId, error: errorMessage(err),
      });
    }
  }

  /** Inbound media is downloaded later (to disk), never inlined as base64. */
  private markMediaPending(envelope: UnifiedEnvelope): MediaInfo | undefined {
    const media = 'media' in envelope.content ? envelope.content.media : undefined;
    if (!media) return undefined;
    delete media.base64;
    media.status = 'pending';
    return media;
  }

  /**
   * Writes the message to the log and stamps `seq`/`accountSeq` on the envelope.
   * Returns false only for a duplicate. When the store keeps failing the message
   * is written off, and goes out live without a sequence.
   */
  private async persist(message: InboundMessage): Promise<boolean> {
    const { store } = this.deps;
    if (!store) return true;
    const { envelope } = message;
    const raw = this.storableRaw(message.raw);
    try {
      const result = await this.insertWithRetries(store, envelope, raw);
      if (!result.inserted) return false;
      envelope.seq = result.seq;
      envelope.accountSeq = result.accountSeq;
    } catch (err) {
      if (this.unsaved.has(message)) await this.writeOff(envelope, raw, err);
    }
    return true;
  }

  private async insertWithRetries(store: MessageLogPort, envelope: UnifiedEnvelope, raw: unknown): Promise<InsertResult> {
    const delays = this.deps.persistRetryDelaysMs ?? PERSIST_RETRY_DELAYS_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        return await store.insertInbound(envelope, raw);
      } catch (err) {
        const delay = delays[attempt];
        if (delay === undefined || this.draining) throw err;
        this.logger.warn('Failed to persist inbound message, retrying', {
          accountId: envelope.accountId, messageId: envelope.id, attempt: attempt + 1, delayMs: delay, error: errorMessage(err),
        });
        await this.waitToRetry(delay);
      }
    }
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

  private storableRaw(raw: unknown): unknown {
    try {
      return (this.deps.toStorableRaw ?? ((value) => value))(raw);
    } catch (err) {
      this.logger.warn('Failed to serialize the raw inbound message, storing it without', { error: errorMessage(err) });
      return undefined;
    }
  }

  private async writeOff(envelope: UnifiedEnvelope, raw: unknown, cause: unknown): Promise<void> {
    const context = { accountId: envelope.accountId, messageId: envelope.id };
    this.deps.metrics.persistFailures();
    this.logger.error('Failed to persist inbound message, keeping it for the next start', { ...context, error: errorMessage(cause) });
    try {
      await this.deps.failedLog?.append({ envelope, raw });
    } catch (err) {
      this.logger.error('Inbound message LOST: it could not be stored nor written to the failed log', { ...context, error: errorMessage(err) });
    }
  }

  /** Handlers start right here, in queue order; the queue does not wait for them to finish. */
  private emit(account: ChannelAccount, envelope: UnifiedEnvelope): void {
    this.deps.eventBus
      .emit(createEvent<MessageInboundPayload>(Events.MESSAGE_INBOUND, account.provider, { envelope }, account.id))
      .catch((err) => this.logger.error('Inbound event emit failed', { accountId: account.id, messageId: envelope.id, error: errorMessage(err) }));
  }

  /** Fire and forget: media must never delay or fail the message. */
  private scheduleMedia(envelope: UnifiedEnvelope, raw: unknown): void {
    const onError = (err: unknown) => this.logger.error('Media processing failed', {
      accountId: envelope.accountId, messageId: envelope.id, error: errorMessage(err),
    });
    try {
      Promise.resolve(this.deps.media.process(envelope, raw)).catch(onError);
    } catch (err) {
      onError(err);
    }
  }
}
