import { randomUUID } from 'node:crypto';
import type { ChannelAccountRepository } from '../accounts/channel-account.repository.js';
import type { MessageResult } from '../messaging/message-result.js';
import type { SendMessageCommand, OutboundMessageContent } from '../messaging/outbound-message.js';
import type { MessagingAdapterFactory } from '../messaging/ports/messaging-adapter.port.js';
import type { EventBus } from '../event-bus.js';
import type { UnifiedEnvelope } from '../messaging/unified-envelope.js';
import type { MessageContent } from '../messaging/content.js';
import type { ChannelAccount } from '../accounts/channel-account.js';
import { Events, createEvent } from '../events.js';
import type { MessageOutboundPayload } from '../events.js';
import { AccountNotFoundError, AccountUnavailableError } from '../errors.js';
import { getLogger } from '../logger/logger.port.js';

export class MessageRouterService {
  constructor(
    private readonly accountRepository: ChannelAccountRepository,
    private readonly adapterFactory: MessagingAdapterFactory,
    private readonly eventBus?: EventBus,
  ) {}

  async send(command: SendMessageCommand): Promise<MessageResult> {
    const account = command.fromAccountId
      ? await this.accountRepository.findById(command.fromAccountId)
      : command.routing
        ? await this.accountRepository.findByRoutingRules(command.routing)
        : undefined;

    if (!account) {
      throw new AccountNotFoundError(command.fromAccountId ?? 'routing');
    }

    if (account.status !== 'active') {
      throw new AccountUnavailableError(account.id, `status is '${account.status}'`);
    }

    const adapter = this.adapterFactory.create(account);

    const result = await adapter.sendMessage({
      to: command.to,
      content: command.content,
      accountId: account.id,
      replyToMessageId: command.replyToMessageId,
      metadata: command.metadata,
    });

    // Emit outbound event for persistence and webhooks
    if (this.eventBus && result.status !== 'failed') {
      this.emitOutbound(account, command, result).catch((err) => {
        getLogger().error('Failed to emit outbound event', {
          accountId: account.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    return result;
  }

  private async emitOutbound(
    account: ChannelAccount,
    command: SendMessageCommand,
    result: MessageResult,
  ): Promise<void> {
    const envelope: UnifiedEnvelope = {
      id: `msg_${randomUUID()}`,
      accountId: account.id,
      channel: account.channel,
      direction: 'outbound',
      timestamp: result.timestamp,
      conversationId: result.remoteJid ?? command.to,
      sender: {
        id: 'phoneNumber' in account.identity ? account.identity.phoneNumber : account.id,
        displayName: account.alias,
      },
      recipient: { id: command.to },
      content: outboundContentToMessageContent(command.content),
      gateway: {
        receivedAt: new Date(),
        adapterId: account.provider,
        account: {
          id: account.id,
          alias: account.alias ?? account.id,
          owner: account.metadata?.owner ?? '',
          tags: account.metadata?.tags ?? [],
        },
      },
    };

    await this.eventBus!.emit(
      createEvent<MessageOutboundPayload>(
        Events.MESSAGE_OUTBOUND,
        'router',
        { envelope },
        account.id,
      ),
    );
  }
}

/** Map OutboundMessageContent to the canonical MessageContent union */
function outboundContentToMessageContent(content: OutboundMessageContent): MessageContent {
  switch (content.type) {
    case 'text':
      return { type: 'text', body: content.body ?? '' };
    case 'image':
      return {
        type: 'image',
        media: { mimeType: content.mimeType ?? 'image/jpeg', url: content.mediaUrl },
        caption: content.caption,
      };
    case 'video':
      return {
        type: 'video',
        media: { mimeType: content.mimeType ?? 'video/mp4', url: content.mediaUrl },
        caption: content.caption,
      };
    case 'audio':
      return {
        type: 'audio',
        media: { mimeType: content.mimeType ?? 'audio/ogg', url: content.mediaUrl },
      };
    case 'document':
      return {
        type: 'document',
        media: { mimeType: content.mimeType ?? 'application/octet-stream', url: content.mediaUrl, filename: content.fileName },
        fileName: content.fileName ?? 'file',
        caption: content.caption,
      };
    case 'location':
      return {
        type: 'location',
        latitude: content.latitude ?? 0,
        longitude: content.longitude ?? 0,
      };
    default:
      return { type: 'text', body: content.body ?? '' };
  }
}
