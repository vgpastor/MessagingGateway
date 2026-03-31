import type { ChannelAccountRepository } from '../accounts/channel-account.repository.js';
import type { MessageResult } from '../messaging/message-result.js';
import type { SendMessageCommand } from '../messaging/outbound-message.js';
import type { AdapterFactory } from '../../integrations/adapter.factory.js';
import { AccountNotFoundError, AccountUnavailableError } from '../errors.js';

export class MessageRouterService {
  constructor(
    private readonly accountRepository: ChannelAccountRepository,
    private readonly adapterFactory: AdapterFactory,
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

    return adapter.sendMessage({
      to: command.to,
      content: command.content,
      accountId: account.id,
      replyToMessageId: command.replyToMessageId,
      metadata: command.metadata,
    });
  }
}
