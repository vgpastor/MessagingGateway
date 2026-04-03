import type { ProviderBundle } from '../../provider-registry.js';
import type { ChannelAccount } from '../../../core/accounts/channel-account.js';
import type { EventBus } from '../../../core/event-bus.js';
import { getLogger } from '../../../core/logger/logger.port.js';
import { Events, createEvent } from '../../../core/events.js';
import type { MessageInboundPayload, ConnectionUpdatePayload } from '../../../core/events.js';
import { BaileysAdapter } from './baileys.adapter.js';
import { BaileysHealthChecker } from './baileys.health-checker.js';
import { BaileysConnectionManager } from './baileys.connection-manager.js';
import { BaileysWebhookAdapter } from './baileys-webhook.adapter.js';
import { BaileysSocketManager } from './baileys-socket.manager.js';
import { mapBaileysToWhatsAppEvent } from './baileys.mapper.js';
import { downloadBaileysMedia } from './baileys-media.js';

const socketManager = new BaileysSocketManager();

export const baileysProvider: ProviderBundle = {
  id: 'baileys',
  channel: 'whatsapp',
  displayName: 'WhatsApp (Baileys)',
  messaging: (config: Record<string, unknown>, cred: string, inline?: string) =>
    new BaileysAdapter(config, cred, inline, socketManager),
  inbound: () => new BaileysWebhookAdapter(),
  health: () => new BaileysHealthChecker(socketManager),
  connection: () => new BaileysConnectionManager(socketManager),

  async wireEvents(account: ChannelAccount, eventBus: EventBus): Promise<void> {
    const inboundAdapter = new BaileysWebhookAdapter();

    socketManager.onMessage(account.id, async (event) => {
      for (const msg of event.messages) {
        if (msg.key?.fromMe) continue;
        try {
          const waEvent = mapBaileysToWhatsAppEvent(msg);
          const envelope = inboundAdapter.toEnvelope(waEvent, account);

          // Download media if present (non-blocking: continues without media on failure)
          if ('media' in envelope.content && envelope.content.media) {
            const media = await downloadBaileysMedia(msg);
            if (media) {
              envelope.content.media.base64 = media.base64;
              if (media.filename) envelope.content.media.filename = media.filename;
            }
          }

          await eventBus.emit(
            createEvent<MessageInboundPayload>(
              Events.MESSAGE_INBOUND,
              'baileys',
              { envelope },
              account.id,
            ),
          );
        } catch (err) {
          getLogger().error('Failed to process inbound message', { provider: 'baileys', accountId: account.id, error: err instanceof Error ? err.message : String(err) });
        }
      }
    });

    socketManager.onConnectionUpdate(account.id, (update) => {
      const status = socketManager.getConnectionStatus(account.id);
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
