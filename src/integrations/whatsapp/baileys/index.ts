import type { ProviderBundle } from '../../provider-registry.js';
import type { ChannelAccount } from '../../../core/accounts/channel-account.js';
import type { EventBus } from '../../../core/event-bus.js';
import { getLogger } from '../../../core/logger/logger.port.js';
import { Events, createEvent } from '../../../core/events.js';
import type { ConnectionUpdatePayload } from '../../../core/events.js';
import type { InboundPipeline } from '../../../core/inbound/inbound-pipeline.js';
import type { UnifiedEnvelope } from '../../../core/messaging/unified-envelope.js';
import { BaileysAdapter } from './baileys.adapter.js';
import { BaileysHealthChecker } from './baileys.health-checker.js';
import { BaileysConnectionManager } from './baileys.connection-manager.js';
import { BaileysWebhookAdapter } from './baileys-webhook.adapter.js';
import { BaileysSocketManager } from './baileys-socket.manager.js';
import { mapBaileysToWhatsAppEvent } from './baileys.mapper.js';
import { createBaileysMessageLookup } from './baileys-message-lookup.js';
import type { MessageLogPort } from '../../../core/persistence/message-store.port.js';
import { noopMetrics, type MetricsPort } from '../../../core/metrics/metrics.port.js';
import { baileysInboundSkipReason, isInboundUpsert, isStatusBroadcast } from './baileys-inbound-skip.js';
import { jidNormalizedUser } from '@whiskeysockets/baileys';

const GROUP_CACHE_TTL = 5 * 60 * 1000;
/** How long a group that could not be resolved is left alone: a burst from it must not wait once per message. */
const GROUP_MISS_TTL = 60 * 1000;
/** Enrichment runs inside the account's queue, so what it asks WhatsApp may hold back every later message up to this long. */
const ENRICH_TIMEOUT_MS = 5_000;

/** Undefined when `work` takes longer than {@link ENRICH_TIMEOUT_MS}: the message goes on without that detail. */
async function withinEnrichBudget<T>(work: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ENRICH_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface BaileysProviderDeps {
  /** Counts messages dropped before the pipeline (see {@link baileysInboundSkipReason}). */
  metrics?: MetricsPort;
  /** Lets Baileys' `getMessage` read from the message log (retries / re-sends). */
  messageStore?: Pick<MessageLogPort, 'findByWaMessageId'>;
}

export interface BaileysProvider extends ProviderBundle {
  /** Resolve a WhatsApp LID to its phone JID using the account's open socket (undefined if unknown). */
  resolveLidToPhone(accountId: string, lid: string): Promise<string | undefined>;
}

export function createBaileysProvider({ metrics = noopMetrics, messageStore }: BaileysProviderDeps = {}): BaileysProvider {
  const socketManager = new BaileysSocketManager({
    messageLookup: messageStore ? createBaileysMessageLookup(messageStore) : undefined,
  });

  // Cache group names to avoid API calls on every message
  const groupNameCache = new Map<string, { name: string | undefined; expires: number }>();

  async function resolveGroupName(accountId: string, groupId: string): Promise<string | undefined> {
    const cacheKey = `${accountId}:${groupId}`;
    const cached = groupNameCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) return cached.name;

    const name = (await withinEnrichBudget(socketManager.getGroupInfo(accountId, groupId)))?.name;
    groupNameCache.set(cacheKey, { name, expires: Date.now() + (name ? GROUP_CACHE_TTL : GROUP_MISS_TTL) });
    return name;
  }

  /** What takes a look-up: it runs in the message's turn, never before it. */
  async function enrichEnvelope(accountId: string, envelope: UnifiedEnvelope): Promise<void> {
    // Resolve LID → phone number for DMs so conversationId matches outbound
    if (envelope.conversationId.endsWith('@lid')) {
      const originalLid = envelope.conversationId;
      const phoneJid = await withinEnrichBudget(socketManager.resolveLidToPhone(accountId, originalLid));
      if (phoneJid) {
        // jidNormalizedUser strips the device suffix (e.g. ":0")
        envelope.conversationId = jidNormalizedUser(phoneJid);
        envelope.sender.id = jidNormalizedUser(phoneJid);
      }
      // Preserve original LID and resolved JID (with device) in channelDetails for future use
      if (envelope.channelDetails) {
        (envelope.channelDetails as Record<string, unknown>).senderLid = originalLid;
        if (phoneJid) {
          (envelope.channelDetails as Record<string, unknown>).senderPhoneJid = phoneJid;
        }
      }
    }

    // Resolve group name for group messages (cached, 5 min TTL)
    if (envelope.channelDetails && envelope.conversationId.endsWith('@g.us')) {
      const groupName = await resolveGroupName(accountId, envelope.conversationId);
      if (groupName) {
        (envelope.channelDetails as Record<string, unknown>).groupName = groupName;
      }
    }
  }

  return {
    id: 'baileys',
    channel: 'whatsapp',
    displayName: 'WhatsApp (Baileys)',
    messaging: (config: Record<string, unknown>, cred: string, inline?: string) =>
      new BaileysAdapter(config, cred, inline, socketManager),
    inbound: () => new BaileysWebhookAdapter(),
    health: () => new BaileysHealthChecker(socketManager),
    connection: () => new BaileysConnectionManager(socketManager),
    shutdown: () => socketManager.closeAll(),
    resolveLidToPhone: (accountId, lid) => socketManager.resolveLidToPhone(accountId, lid),

    /**
     * Idempotent per account: the socket manager appends handlers on every
     * registration, so a second call would deliver each message twice. Boot wiring
     * and hot wiring (accounts created or connected through the API) both land here.
     * The guard is the socket manager's own record of registered handlers, so it
     * resets when a disconnect forgets them and the account can be wired again.
     */
    async wireEvents(account: ChannelAccount, eventBus: EventBus, inbound: InboundPipeline): Promise<void> {
      if (socketManager.isWired(account.id)) return;
      const inboundAdapter = new BaileysWebhookAdapter();

      const logFailure = (err: unknown) => {
        getLogger().error('Failed to process inbound message', { provider: 'baileys', accountId: account.id, error: err instanceof Error ? err.message : String(err) });
      };

      // Nothing here may await: each message must take its turn in the pipeline's queue
      // before the next one, and the next upsert, can run. The slow part goes in `enrich`.
      socketManager.onMessage(account.id, (event) => {
        if (!isInboundUpsert(event.type)) return;
        for (const msg of event.messages) {
          try {
            if (msg.key?.fromMe || isStatusBroadcast(msg)) continue;
            const skip = baileysInboundSkipReason(msg);
            if (skip) {
              metrics.inboundSkipped(skip);
              getLogger().debug('Skipped inbound message', { provider: 'baileys', accountId: account.id, messageId: msg.key?.id, reason: skip });
              continue;
            }
            const envelope = inboundAdapter.toEnvelope(mapBaileysToWhatsAppEvent(msg), account);
            // Filter → persist → emit → media all happen in the pipeline
            inbound.handle(account, envelope, msg, () => enrichEnvelope(account.id, envelope)).catch(logFailure);
          } catch (err) {
            logFailure(err);
          }
        }
      });

      socketManager.onConnectionUpdate(account.id, (update) => {
        const closeCode = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        const end = socketManager.getConnectionEnd(account.id);
        const payload: ConnectionUpdatePayload = {
          accountId: account.id,
          // A lost session gets its own status: unlike a dropped connection, no reconnect follows.
          status: end === 'session_lost' ? 'auth_expired' : end === 'closed' ? 'disconnected' : socketManager.getConnectionStatus(account.id),
          qr: update.qr ?? socketManager.getLastQr(account.id),
          ...(closeCode === undefined ? {} : { closeCode }),
          ...(end === 'closed' ? { deliberate: true } : {}),
        };
        eventBus.emit(
          createEvent<ConnectionUpdatePayload>(Events.CONNECTION_UPDATE, 'baileys', payload, account.id),
        ).catch((err) => {
          getLogger().error('Failed to emit connection update', { provider: 'baileys', accountId: account.id, error: err instanceof Error ? err.message : String(err) });
        });
      });
    },
  };
}
