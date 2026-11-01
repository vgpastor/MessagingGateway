import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../../../src/core/event-bus.js';
import { Events, createEvent } from '../../../src/core/events.js';
import type { ConnectionUpdatePayload } from '../../../src/core/events.js';
import { subscribeAccountStatus } from '../../../src/core/accounts/account-status.subscriber.js';
import type { AccountStatus, ChannelAccount } from '../../../src/core/accounts/channel-account.js';
import { MessageRouterService } from '../../../src/core/routing/message-router.service.js';
import { AccountUnavailableError } from '../../../src/core/errors.js';
import { getLogger, setGlobalLogger, type Logger } from '../../../src/core/logger/logger.port.js';
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

describe('account status from connection events, when accounts.yaml cannot be written', () => {
  const originalLogger = getLogger();
  let dir: string;
  let error: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'account-status-'));
    await writeFile(join(dir, 'not-a-directory'), '');
    error = vi.fn();
    const fake = { info: vi.fn(), warn: vi.fn(), error, debug: vi.fn(), child: () => fake };
    setGlobalLogger(fake as unknown as Logger);
  });

  afterEach(async () => {
    setGlobalLogger(originalLogger);
    await rm(dir, { recursive: true, force: true });
  });

  function setupOnBrokenDisk(status: AccountStatus) {
    const repository = new InMemoryAccountRepository(
      [{ id: 'wa-1', status, provider: 'baileys', channel: 'whatsapp', identity: {}, providerConfig: {}, metadata: { tags: [] } } as unknown as ChannelAccount],
      join(dir, 'not-a-directory', 'accounts.yaml'),
    );
    const eventBus = new EventBus();
    subscribeAccountStatus(eventBus, repository);
    const report = (data: Omit<ConnectionUpdatePayload, 'accountId'>) =>
      eventBus.emit(createEvent<ConnectionUpdatePayload>(Events.CONNECTION_UPDATE, 'baileys', { accountId: 'wa-1', ...data }, 'wa-1'));
    return { repository, report };
  }

  it.each([
    ['auth_expired', 'connected', 'active'],
    ['active', 'auth_expired', 'auth_expired'],
  ] as const)('a %s account that hears %s is %s all the same, and the failed write is logged as an error', async (from, heard, expected) => {
    const { repository, report } = setupOnBrokenDisk(from);

    await report({ status: heard });

    expect((await repository.findById('wa-1'))?.status).toBe(expected);
    expect(error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ accountId: 'wa-1' }));
  });

  it('so a lost session stops the sends even though the disk is gone', async () => {
    const { repository, report } = setupOnBrokenDisk('active');
    await report({ status: 'auth_expired' });
    const router = new MessageRouterService(repository, { create: () => { throw new Error('reached the provider'); } } as never);

    await expect(router.send({ fromAccountId: 'wa-1', to: 'x', content: { type: 'text', body: 'hola' } } as never)).rejects.toBeInstanceOf(AccountUnavailableError);
  });

  it('a change requested through the API still fails and changes nothing, while what was observed stands', async () => {
    const { repository, report } = setupOnBrokenDisk('active');
    await report({ status: 'auth_expired' });

    await expect(repository.update('wa-1', { alias: 'lost' })).rejects.toThrow();

    expect(await repository.findById('wa-1')).toMatchObject({ status: 'auth_expired' });
    expect((await repository.findById('wa-1'))?.alias).toBeUndefined();
  });
});

describe('what is observed of an account', () => {
  it('waits its turn, so it does not undo a suspension being written', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'account-status-'));
    try {
      const path = join(dir, 'accounts.yaml');
      const repository = new InMemoryAccountRepository(
        [{ id: 'wa-1', alias: 'a', status: 'auth_expired', provider: 'baileys', channel: 'whatsapp', identity: {}, providerConfig: {}, metadata: { tags: [] } } as unknown as ChannelAccount],
        path,
      );
      const eventBus = new EventBus();
      subscribeAccountStatus(eventBus, repository);

      const suspending = repository.update('wa-1', { status: 'suspended' });
      await eventBus.emit(createEvent<ConnectionUpdatePayload>(Events.CONNECTION_UPDATE, 'baileys', { accountId: 'wa-1', status: 'connected' }, 'wa-1'));
      await suspending;

      expect((await repository.findById('wa-1'))?.status).toBe('suspended');
      expect(await readFile(path, 'utf-8')).toContain('suspended');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
