import type { ChannelAccount } from '../accounts/channel-account.js';
import type { ChannelAccountRepository } from '../accounts/channel-account.repository.js';
import type { EventBus } from '../event-bus.js';
import { Events, createEvent } from '../events.js';
import type { MessageInboundPayload } from '../events.js';
import { getLogger } from '../logger/logger.port.js';
import type { MediaInfo } from '../messaging/content.js';
import type { UnifiedEnvelope } from '../messaging/unified-envelope.js';
import type { MetricsPort } from '../metrics/metrics.port.js';
import type { MessageLogPort } from '../persistence/message-store.port.js';
import type { FailedInboundLog } from './failed-inbound-log.js';
import type { MediaService } from './media-service.js';
import { StoreGuard } from './store-guard.js';

export interface InboundPipelineDeps {
  /** Message log. Undefined when storage is disabled: messages are then emitted without a sequence. */
  store?: MessageLogPort;
  /** Where a message goes when the log will not take it, until the log is back or the next start. */
  failedLog?: FailedInboundLog;
  eventBus: EventBus;
  media: MediaService;
  metrics: MetricsPort;
  /** Where {@link InboundPipeline.replayFailed} reads an account as it is today: its list may have changed since. */
  accounts: Pick<ChannelAccountRepository, 'findById'>;
  /** Resolves a WhatsApp LID to its phone JID (`digits[:device]@s.whatsapp.net`) or bare number. */
  resolveLidToPhone?: (accountId: string, lid: string) => Promise<string | undefined>;
  /** Turns the provider's raw message into something storable as JSON (strip binaries...). Identity by default. */
  toStorableRaw?: (raw: unknown) => unknown;
  /** {@link PERSIST_RETRY_DELAYS_MS} by default. */
  persistRetryDelaysMs?: readonly number[];
  /** {@link STORE_PROBE_INTERVAL_MS} by default. */
  storeProbeIntervalMs?: number;
}

/** What became of a message on its way to the log. Storage disabled counts as stored: there is nothing to wait for. */
type PersistOutcome = 'stored' | 'duplicate' | 'written_off';

/**
 * How long after connecting the accounts to look at the failed log again. As long as a connection attempt may
 * take: by then an account that could connect has a socket, which is what a LID needs to be resolved.
 */
export const REPLAY_AFTER_CONNECT_MS = 60_000;

interface InboundMessage {
  account: ChannelAccount;
  envelope: UnifiedEnvelope;
  raw: unknown;
  /** Still to run, so the envelope is not final yet. */
  enrich?: () => Promise<void>;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The phone number in what a LID resolves to: `34600111222:5@s.whatsapp.net` gives `34600111222`. */
const phoneDigits = (resolved: string | undefined): string | undefined =>
  resolved?.split('@')[0]?.split(':')[0]?.replace(/\D/g, '') || undefined;

/**
 * Single entry point for inbound messages: filter → persist → emit → media.
 *
 * Persisting strictly before emitting is what makes `accountSeq` trustworthy:
 * a consumer that sees a gap knows a message was lost, so no event may carry a
 * sequence that is not yet in the log. A duplicate (already logged) is neither
 * emitted nor reprocessed.
 *
 * Messages of the same account are stored one at a time, in the order they
 * reach {@link handle}: the log assigns `accountSeq` in insert order. So a message
 * takes its turn synchronously and anything slow it needs (`enrich`) runs inside
 * the queue, on the caller's promise to keep that work short. Their event
 * handlers start in that same order, but the queue never waits for them: storing
 * must not depend on how fast a subscriber is. Accounts do not block each other.
 *
 * A message the log will not take ({@link StoreGuard} decides how hard to try) goes to the
 * failed log and is still delivered live, without a sequence. The failed log is stored
 * ({@link replayFailed}) as soon as the log is back after an outage, and at every start.
 */
export class InboundPipeline {
  private get logger() {
    return getLogger().child({ module: 'inbound-pipeline' });
  }

  /** Tail of each account's queue; it never rejects, so one failure cannot break the chain. */
  private readonly queues = new Map<string, Promise<void>>();
  /** Accepted by {@link handle} and neither stored nor written off yet: what a shutdown must not lose. */
  private readonly unsaved = new Set<InboundMessage>();
  private readonly guard: StoreGuard | undefined;
  private replayTimer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: InboundPipelineDeps) {
    this.guard = deps.store && new StoreGuard(deps.store, {
      retryDelaysMs: deps.persistRetryDelaysMs,
      probeIntervalMs: deps.storeProbeIntervalMs,
      onRecovered: () => void this.recoverFailedLog(),
    });
  }

  handle(account: ChannelAccount, envelope: UnifiedEnvelope, raw: unknown, enrich?: () => Promise<void>): Promise<void> {
    const message: InboundMessage = { account, envelope, raw, enrich };
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
   *
   * The conversation filter applies again. What it excludes, and what belongs to an account that no
   * longer exists, leaves the log. What it cannot judge yet (a LID, with no socket to resolve it) stays:
   * {@link replayAfterConnecting} looks again, and whatever is still unresolved waits for the next start.
   * Resolves to how many entries reached the log.
   */
  async replayFailed(): Promise<number> {
    const { guard } = this;
    const { failedLog } = this.deps;
    if (!guard || !failedLog) return 0;
    let discarded = 0;
    const { saved, kept } = await failedLog.replay(async ({ envelope, raw }) => {
      const reason = await this.replayRejection(envelope);
      if (reason) {
        discarded += 1;
        this.logger.warn('Discarded an inbound message from the failed log', { accountId: envelope.accountId, messageId: envelope.id, reason });
        return;
      }
      await guard.insertOnce(envelope, raw);
    });
    const stored = saved - discarded;
    if (stored > 0) this.logger.info('Stored inbound messages from the failed log', { saved: stored });
    if (kept > 0) this.logger.error('Inbound messages remain in the failed log', { kept });
    return stored;
  }

  /** {@link replayFailed} away from the first pass of a start: nobody else will pick up the media of what it stores. */
  private async recoverFailedLog(): Promise<void> {
    try {
      if ((await this.replayFailed()) > 0) await this.deps.media.resumePendingMedia();
    } catch (err) {
      this.logger.error('Failed to recover the failed inbound log', { error: errorMessage(err) });
    }
  }

  /**
   * The second pass of a start, once the accounts have had time to connect. It runs off the start-up path, so
   * it also picks up the media of what it stores. Live messages are flowing by then: what it stores gets a later number.
   */
  replayAfterConnecting(delayMs: number = REPLAY_AFTER_CONNECT_MS): void {
    this.replayTimer = setTimeout(() => void this.recoverFailedLog(), delayMs);
    this.replayTimer.unref();
  }

  /**
   * Why this entry must not be stored, if so; rejects when that cannot be told yet, so it stays in the log.
   * Resolving a LID on the way leaves the envelope as live enrichment would.
   */
  private async replayRejection(envelope: UnifiedEnvelope): Promise<string | undefined> {
    const account = await this.deps.accounts.findById(envelope.accountId);
    if (!account) return 'the account no longer exists';
    if (this.judgesConversations(account) && envelope.conversationId.endsWith('@lid')) {
      const phoneJid = await this.resolveLidToPhoneJid(envelope.accountId, envelope.conversationId);
      if (!phoneJid) throw new Error('its conversation is a LID that cannot be resolved yet, so it cannot be judged');
      envelope.conversationId = phoneJid;
      envelope.sender.id = phoneJid;
    }
    return this.accepts(account, envelope) ? undefined : 'the account excludes its conversation';
  }

  private judgesConversations(account: ChannelAccount): boolean {
    return account.conversations !== undefined && account.conversations !== '*';
  }

  private async resolveLidToPhoneJid(accountId: string, lid: string): Promise<string | undefined> {
    try {
      const digits = phoneDigits(await this.deps.resolveLidToPhone?.(accountId, lid));
      return digits ? `${digits}@s.whatsapp.net` : undefined;
    } catch (err) {
      this.logger.warn('Failed to resolve a LID from the failed log', { accountId, error: errorMessage(err) });
      return undefined;
    }
  }

  /**
   * For shutdown: stops waiting between attempts, gives the queues up to `timeoutMs`,
   * and writes off to the failed log whatever is still not stored by then.
   */
  async drain(timeoutMs: number): Promise<void> {
    this.guard?.stop();
    clearTimeout(this.replayTimer);

    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(this.queues.values()),
      new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
    clearTimeout(timer);

    const left = [...this.unsaved];
    this.unsaved.clear();
    for (const { account, envelope, raw, enrich } of left) {
      try {
        // Only a LID still to enrich cannot be judged yet: it goes to the log, whose replay judges it again.
        const unjudgeable = enrich !== undefined && envelope.conversationId.endsWith('@lid');
        if (!unjudgeable && !this.accepts(account, envelope)) continue;
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
      await this.enrich(message);
      if (!this.unsaved.has(message)) return; // drain() gave up on it meanwhile
      if (!this.accepts(account, envelope)) {
        this.recordFiltered(envelope);
        return;
      }

      await this.resolveSenderPhone(envelope);
      const media = this.markMediaPending(envelope);

      const outcome = await this.persist(message);
      if (outcome === 'duplicate') return;

      this.deps.metrics.lastInbound(account.id, Math.floor(Date.now() / 1000));
      this.emit(account, envelope);

      // Not stored means no row to record it on: it is downloaded once the failed log reaches the message log.
      if (media && outcome === 'stored') this.scheduleMedia(envelope, raw);
    } finally {
      this.unsaved.delete(message);
    }
  }

  /** A failure leaves the envelope as it was: losing a detail must not lose the message. */
  private async enrich(message: InboundMessage): Promise<void> {
    if (!message.enrich) return;
    try {
      await message.enrich();
    } catch (err) {
      this.logger.warn('Failed to enrich inbound message', {
        accountId: message.account.id, messageId: message.envelope.id, error: errorMessage(err),
      });
    }
    message.enrich = undefined;
  }

  private accepts(account: ChannelAccount, envelope: UnifiedEnvelope): boolean {
    const allowed = account.conversations;
    return allowed === undefined || allowed === '*' || allowed.includes(envelope.conversationId);
  }

  private recordFiltered(envelope: UnifiedEnvelope): void {
    const reason = envelope.conversationId.endsWith('@lid') ? 'lid_unresolved' : 'conversation_excluded';
    this.deps.metrics.inboundFiltered(reason);
    this.logger.debug('Inbound message filtered out', { accountId: envelope.accountId, messageId: envelope.id, reason });
  }

  /** WhatsApp sometimes identifies a sender by LID only; the phone is what consumers match on. */
  private async resolveSenderPhone(envelope: UnifiedEnvelope): Promise<void> {
    const { sender } = envelope;
    if (sender.phone || !sender.lid || !this.deps.resolveLidToPhone) return;
    try {
      const digits = phoneDigits(await this.deps.resolveLidToPhone(envelope.accountId, sender.lid));
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

  /** Writes the message to the log and stamps `seq`/`accountSeq` on the envelope, or writes it off without them. */
  private async persist(message: InboundMessage): Promise<PersistOutcome> {
    if (!this.guard) return 'stored';
    const { envelope } = message;
    const raw = this.storableRaw(message.raw);
    try {
      const result = await this.guard.insert(envelope, raw);
      if (!result.inserted) return 'duplicate';
      envelope.seq = result.seq;
      envelope.accountSeq = result.accountSeq;
      return 'stored';
    } catch (err) {
      if (this.unsaved.has(message)) await this.writeOff(envelope, raw, err);
      return 'written_off';
    }
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
    this.logger.error('Failed to persist inbound message, keeping it in the failed log', { ...context, error: errorMessage(cause) });
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
