import type { ChannelAccount } from '../accounts/channel-account.js';
import type { EventBus } from '../event-bus.js';
import { Events, createEvent } from '../events.js';
import type { MessageInboundPayload } from '../events.js';
import { getLogger } from '../logger/logger.port.js';
import type { MediaInfo } from '../messaging/content.js';
import type { UnifiedEnvelope } from '../messaging/unified-envelope.js';
import type { MetricsPort } from '../metrics/metrics.port.js';
import type { MessageLogPort } from '../persistence/message-store.port.js';
import type { MediaService } from './media-service.js';

export type UpsertType = 'notify' | 'append';

const ACCEPTED_UPSERT_TYPES: ReadonlySet<string> = new Set<UpsertType>(['notify', 'append']);
const STATUS_BROADCAST = 'status@broadcast';

export interface InboundPipelineDeps {
  /** Message log. Undefined when storage is disabled: messages are then emitted without a sequence. */
  store?: MessageLogPort;
  eventBus: EventBus;
  media: MediaService;
  metrics: MetricsPort;
  /** Resolves a WhatsApp LID to its phone JID (`digits[:device]@s.whatsapp.net`) or bare number. */
  resolveLidToPhone?: (accountId: string, lid: string) => Promise<string | undefined>;
  /** Turns the provider's raw message into something storable as JSON (strip binaries...). Identity by default. */
  toStorableRaw?: (raw: unknown) => unknown;
}

/**
 * Single entry point for inbound messages: filter → persist → emit → media.
 *
 * Persisting strictly before emitting is what makes `accountSeq` trustworthy:
 * a consumer that sees a gap knows a message was lost, so no event may carry a
 * sequence that is not yet in the log. A duplicate (already logged) is neither
 * emitted nor reprocessed.
 *
 * Messages of the same account are processed one at a time, in the order they
 * reach {@link handle}: the log assigns `accountSeq` in insert order, so emitting
 * out of that order would show consumers a false gap. Accounts do not block
 * each other.
 */
export class InboundPipeline {
  private get logger() {
    return getLogger().child({ module: 'inbound-pipeline' });
  }

  /** Tail of each account's queue; it never rejects, so one failure cannot break the chain. */
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly deps: InboundPipelineDeps) {}

  handle(account: ChannelAccount, envelope: UnifiedEnvelope, raw: unknown, upsertType: UpsertType): Promise<void> {
    const previous = this.queues.get(account.id) ?? Promise.resolve();
    const run = previous.then(() => this.process(account, envelope, raw, upsertType));
    const tail = run.catch((err) => {
      this.logger.error('Inbound message processing failed', {
        accountId: account.id, messageId: envelope.id, error: err instanceof Error ? err.message : String(err),
      });
    });
    this.queues.set(account.id, tail);
    void tail.then(() => {
      if (this.queues.get(account.id) === tail) this.queues.delete(account.id);
    });
    return run;
  }

  private async process(
    account: ChannelAccount,
    envelope: UnifiedEnvelope,
    raw: unknown,
    upsertType: UpsertType,
  ): Promise<void> {
    if (!this.accepts(account, envelope, upsertType)) return;

    await this.resolveSenderPhone(envelope);
    const media = this.markMediaPending(envelope);

    if (!(await this.persist(envelope, raw))) return;

    await this.deps.eventBus.emit(
      createEvent<MessageInboundPayload>(Events.MESSAGE_INBOUND, account.provider, { envelope }, account.id),
    );

    if (media) this.scheduleMedia(envelope, raw);
  }

  private accepts(account: ChannelAccount, envelope: UnifiedEnvelope, upsertType: string): boolean {
    if (!ACCEPTED_UPSERT_TYPES.has(upsertType)) return false;
    if (envelope.conversationId === STATUS_BROADCAST) return false;
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
        accountId: envelope.accountId, error: err instanceof Error ? err.message : String(err),
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
   * Returns false only for a duplicate. A storage failure must not lose the live
   * message, so it is counted and the message goes out without a sequence.
   */
  private async persist(envelope: UnifiedEnvelope, raw: unknown): Promise<boolean> {
    const { store } = this.deps;
    if (!store) return true;
    try {
      const result = await store.insertInbound(envelope, (this.deps.toStorableRaw ?? ((value) => value))(raw));
      if (!result.inserted) return false;
      envelope.seq = result.seq;
      envelope.accountSeq = result.accountSeq;
    } catch (err) {
      this.deps.metrics.persistFailures();
      this.logger.error('Failed to persist inbound message', {
        accountId: envelope.accountId, messageId: envelope.id, error: err instanceof Error ? err.message : String(err),
      });
    }
    return true;
  }

  /** Fire and forget: media must never delay or fail the message. */
  private scheduleMedia(envelope: UnifiedEnvelope, raw: unknown): void {
    const onError = (err: unknown) => this.logger.error('Media processing failed', {
      accountId: envelope.accountId, messageId: envelope.id, error: err instanceof Error ? err.message : String(err),
    });
    try {
      Promise.resolve(this.deps.media.process(envelope, raw)).catch(onError);
    } catch (err) {
      onError(err);
    }
  }
}
