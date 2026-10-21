import type { proto } from '@whiskeysockets/baileys';
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
import { toStorableRaw } from './storable-raw.js';

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
}

/**
 * Single entry point for inbound messages: filter → persist → emit → media.
 *
 * Persisting strictly before emitting is what makes `accountSeq` trustworthy:
 * a consumer that sees a gap knows a message was lost, so no event may carry a
 * sequence that is not yet in the log. A duplicate (already logged) is neither
 * emitted nor reprocessed.
 */
export class InboundPipeline {
  private get logger() {
    return getLogger().child({ module: 'inbound-pipeline' });
  }

  constructor(private readonly deps: InboundPipelineDeps) {}

  async handle(
    account: ChannelAccount,
    envelope: UnifiedEnvelope,
    raw: proto.IWebMessageInfo,
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
  private async persist(envelope: UnifiedEnvelope, raw: proto.IWebMessageInfo): Promise<boolean> {
    const { store } = this.deps;
    if (!store) return true;
    try {
      const result = await store.insertInbound(envelope, toStorableRaw(raw));
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
  private scheduleMedia(envelope: UnifiedEnvelope, raw: proto.IWebMessageInfo): void {
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
