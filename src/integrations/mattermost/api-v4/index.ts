import type { ProviderBundle } from '../../provider-registry.js';
import type { ChannelAccount } from '../../../core/accounts/channel-account.js';
import type { EventBus } from '../../../core/event-bus.js';
import { getLogger } from '../../../core/logger/logger.port.js';
import { Events, createEvent } from '../../../core/events.js';
import type { MessageInboundPayload, ConnectionUpdatePayload } from '../../../core/events.js';
import { MattermostAdapter } from './mattermost.adapter.js';
import { MattermostHealthChecker } from './mattermost.health-checker.js';
import { MattermostConnectionManager } from './mattermost.connection-manager.js';
import { mattermostSocketManager } from './mattermost.socket-manager.js';
import { buildMattermostEnvelope } from '../mattermost-content.mapper.js';

async function downloadMattermostMedia(
  adapter: MattermostAdapter,
  fileId: string,
): Promise<{ base64: string; mimeType: string } | null> {
  try {
    const media = await adapter.downloadMedia(fileId);
    return { base64: media.data.toString('base64'), mimeType: media.mimeType };
  } catch {
    return null;
  }
}

export const mattermostProvider: ProviderBundle = {
  id: 'mattermost',
  channel: 'mattermost',
  displayName: 'Mattermost',
  messaging: (config: Record<string, unknown>, cred: string, inline?: string) =>
    new MattermostAdapter(config, cred, inline),
  health: () => new MattermostHealthChecker(),
  connection: () => new MattermostConnectionManager(mattermostSocketManager),

  async wireEvents(account: ChannelAccount, eventBus: EventBus): Promise<void> {
    const adapter = new MattermostAdapter(
      account.providerConfig,
      account.credentialsRef,
      account.credentials,
    );

    mattermostSocketManager.onMessage(account.id, async (_event, post) => {
      try {
        const envelope = buildMattermostEnvelope(post, account);

        // Download media if present (non-blocking: continues without media on failure)
        if ('media' in envelope.content && envelope.content.media?.id) {
          const downloaded = await downloadMattermostMedia(adapter, envelope.content.media.id);
          if (downloaded) {
            envelope.content.media.base64 = downloaded.base64;
            envelope.content.media.mimeType = downloaded.mimeType;
          }
        }

        getLogger().info('Mattermost inbound message processed', {
          provider: 'mattermost',
          accountId: account.id,
          postId: post.id,
          channel: envelope.channel,
          contentType: envelope.content.type,
          conversationId: envelope.conversationId,
        });

        await eventBus.emit(
          createEvent<MessageInboundPayload>(
            Events.MESSAGE_INBOUND,
            'mattermost',
            { envelope },
            account.id,
          ),
        );
      } catch (err) {
        getLogger().error('Failed to process Mattermost inbound message', {
          provider: 'mattermost',
          accountId: account.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    mattermostSocketManager.onConnectionUpdate(account.id, (status) => {
      eventBus.emit(
        createEvent<ConnectionUpdatePayload>(
          Events.CONNECTION_UPDATE,
          'mattermost',
          { accountId: account.id, status },
          account.id,
        ),
      ).catch((err) => {
        getLogger().error('Failed to emit Mattermost connection update', {
          provider: 'mattermost',
          accountId: account.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });
  },
};
