import { describe, it, expect } from 'vitest';
import { EventBus } from '../../../src/core/event-bus.js';
import { Events, createEvent } from '../../../src/core/events.js';
import type { ConnectionUpdatePayload } from '../../../src/core/events.js';
import { subscribeAccountStatus } from '../../../src/core/accounts/account-status.subscriber.js';
import type { AccountStatus, ChannelAccount } from '../../../src/core/accounts/channel-account.js';
import { MessageRouterService } from '../../../src/core/routing/message-router.service.js';
import { AccountUnavailableError } from '../../../src/core/errors.js';
import { InMemoryAccountRepository } from '../../../src/infrastructure/config/in-memory-account.repository.js';

function setup(status: AccountStatus) {
  const repository = new InMemoryAccountRepository([{ id: 'wa-1', status, provider: 'baileys', channel: 'whatsapp', metadata: { tags: [] } } as unknown as ChannelAccount]);
  const eventBus = new EventBus();
  subscribeAccountStatus(eventBus, repository);
  const report = (data: Omit<ConnectionUpdatePayload, 'accountId'>) =>
    eventBus.emit(createEvent<ConnectionUpdatePayload>(Events.CONNECTION_UPDATE, 'baileys', { accountId: 'wa-1', ...data }, 'wa-1'));
  const current = async () => (await repository.findById('wa-1'))?.status;
  return { repository, report, current };
}

describe('account status from connection events', () => {
  it('a dropped connection is not a lost session: the account stays active while it reconnects', async () => {
    const { report, current } = setup('active');

    await report({ status: 'disconnected', closeCode: 428 });

    expect(await current()).toBe('active');
  });

  it('so the router does not reject sends for the account during the cut', async () => {
    const { repository, report } = setup('active');
    await report({ status: 'disconnected', closeCode: 428 });
    const router = new MessageRouterService(repository, { create: () => { throw new Error('reached the provider'); } } as never);

    const sending = router.send({ fromAccountId: 'wa-1', to: 'x', content: { type: 'text', body: 'hola' } } as never);

    await expect(sending).rejects.toThrow('reached the provider');
    await expect(sending).rejects.not.toBeInstanceOf(AccountUnavailableError);
  });

  it('a lost session is auth_expired', async () => {
    const { report, current } = setup('active');

    await report({ status: 'auth_expired', closeCode: 401 });

    expect(await current()).toBe('auth_expired');
  });

  it.each(['auth_expired', 'unchecked', 'error'] as const)('connecting makes a %s account active', async (status) => {
    const { report, current } = setup(status);

    await report({ status: 'connected' });

    expect(await current()).toBe('active');
  });

  it.each(['connected', 'auth_expired', 'disconnected'] as const)('%s does not bring a suspended account back', async (status) => {
    const { report, current } = setup('suspended');

    await report({ status });

    expect(await current()).toBe('suspended');
  });

  it('ignores an account that no longer exists', async () => {
    const { repository, report } = setup('active');
    await repository.remove('wa-1');

    await expect(report({ status: 'connected' })).resolves.toBeUndefined();
    expect(await repository.findById('wa-1')).toBeUndefined();
  });
});
