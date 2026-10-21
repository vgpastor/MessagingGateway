import type { ProviderBundle } from '../../provider-registry.js';
import type { ChannelAccount } from '../../../core/accounts/channel-account.js';
import type { EventBus } from '../../../core/event-bus.js';
import { getLogger } from '../../../core/logger/logger.port.js';
import { Events, createEvent } from '../../../core/events.js';
import type { ConnectionUpdatePayload } from '../../../core/events.js';
import type { InboundPipeline } from '../../../core/inbound/inbound-pipeline.js';
import { BaileysAdapter } from './baileys.adapter.js';
import { BaileysHealthChecker } from './baileys.health-checker.js';
import { BaileysConnectionManager } from './baileys.connection-manager.js';
import { BaileysWebhookAdapter } from './baileys-webhook.adapter.js';
import { BaileysSocketManager } from './baileys-socket.manager.js';
import { mapBaileysToWhatsAppEvent } from './baileys.mapper.js';
import { createBaileysMessageLookup } from './baileys-message-lookup.js';
import type { MessageLogPort } from '../../../core/persistence/message-store.port.js';
import { jidNormalizedUser, DisconnectReason } from '@whiskeysockets/baileys';

const socketManager = new BaileysSocketManager();

/** Let Baileys' `getMessage` read from the message log (retries / re-sends). Call once the store exists. */
export function setBaileysMessageStore(store: Pick<MessageLogPort, 'findByWaMessageId'> | undefined): void {
  socketManager.setMessageLookup(store ? createBaileysMessageLookup(store) : undefined);
}

/** Resolve a WhatsApp LID to its phone JID using the account's open socket (undefined if unknown). */
export function resolveBaileysLidToPhone(accountId: string, lid: string): Promise<string | undefined> {
  return socketManager.resolveLidToPhone(accountId, lid);
}

// Cache group names to avoid API calls on every message (TTL: 5 min)
const groupNameCache = new Map<string, { name: string; expires: number }>();
const GROUP_CACHE_TTL = 5 * 60 * 1000;

async function resolveGroupName(accountId: string, groupId: string): Promise<string | undefined> {
  const cacheKey = `${accountId}:${groupId}`;
  const cached = groupNameCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.name;

  try {
    const info = await socketManager.getGroupInfo(accountId, groupId);
    if (info) {
      groupNameCache.set(cacheKey, { name: info.name, expires: Date.now() + GROUP_CACHE_TTL });
      return info.name;
    }
  } catch {
    // Non-blocking
  }
  return undefined;
}

export const baileysProvider: ProviderBundle = {
  id: 'baileys',
  channel: 'whatsapp',
  displayName: 'WhatsApp (Baileys)',
  messaging: (config: Record<string, unknown>, cred: string, inline?: string) =>
    new BaileysAdapter(config, cred, inline, socketManager),
  inbound: () => new BaileysWebhookAdapter(),
  health: () => new BaileysHealthChecker(socketManager),
  connection: () => new BaileysConnectionManager(socketManager),

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

    socketManager.onMessage(account.id, async (event) => {
      for (const msg of event.messages) {
        if (msg.key?.fromMe) continue;
        try {
          const waEvent = mapBaileysToWhatsAppEvent(msg);
          const envelope = inboundAdapter.toEnvelope(waEvent, account);

          // Resolve LID → phone number for DMs so conversationId matches outbound
          if (envelope.conversationId.endsWith('@lid')) {
            const originalLid = envelope.conversationId;
            const phoneJid = await socketManager.resolveLidToPhone(account.id, originalLid);
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
            const groupName = await resolveGroupName(account.id, envelope.conversationId);
            if (groupName) {
              (envelope.channelDetails as Record<string, unknown>).groupName = groupName;
            }
          }

          // Filter → persist → emit → media all happen in the pipeline
          await inbound.handle(account, envelope, msg, event.type);
        } catch (err) {
          getLogger().error('Failed to process inbound message', { provider: 'baileys', accountId: account.id, error: err instanceof Error ? err.message : String(err) });
        }
      }
    });

    socketManager.onConnectionUpdate(account.id, (update) => {
      // 401 loggedOut: WhatsApp unlinked the device and the socket manager will
      // not reconnect. Report it as auth_expired so it gets alerted, not just logged.
      const statusCode = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      const loggedOut = update.connection === 'close' && statusCode === DisconnectReason.loggedOut;
      const status = loggedOut ? 'auth_expired' : socketManager.getConnectionStatus(account.id);
      const qr = update.qr ?? socketManager.getLastQr(account.id);
      eventBus.emit(
        createEvent<ConnectionUpdatePayload>(
          Events.CONNECTION_UPDATE,
          'baileys',
          { accountId: account.id, status, qr },
          account.id,
        ),
      ).catch((err) => {
        getLogger().error('Failed to emit connection update', { provider: 'baileys', accountId: account.id, error: err instanceof Error ? err.message : String(err) });
      });
    });
  },
};
