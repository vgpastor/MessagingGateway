import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { InMemoryAccountRepository } from '../../../src/infrastructure/config/in-memory-account.repository.js';
import { loadAccountsFromYaml } from '../../../src/infrastructure/config/accounts.loader.js';
import type { ChannelAccount } from '../../../src/core/accounts/channel-account.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, rename: vi.fn(original.rename), open: vi.fn(original.open) };
});

function account(id: string): ChannelAccount {
  return {
    id, alias: id, channel: 'whatsapp', provider: 'baileys', status: 'active',
    identity: { channel: 'whatsapp', phoneNumber: '+34600000001' },
    credentialsRef: '', providerConfig: {},
    metadata: { owner: 'org', environment: 'production', tags: [] },
  };
}

describe('InMemoryAccountRepository persistence', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'accounts-repo-'));
    path = join(dir, 'nested', 'accounts.yaml');
  });

  afterEach(async () => {
    vi.mocked(fsPromises.rename).mockClear();
    vi.mocked(fsPromises.open).mockClear();
    await rm(dir, { recursive: true, force: true });
  });

  it('is on disk by the time the write returns, and the next start can load it', async () => {
    const repository = new InMemoryAccountRepository([], path);

    await repository.save(account('wa-1'));
    await repository.update('wa-1', { alias: 'renamed', conversations: ['123@g.us'] });

    const [loaded] = loadAccountsFromYaml(path);
    expect(loaded?.alias).toBe('renamed');
    expect(loaded?.conversations).toEqual(['123@g.us']);
  });

  it('many updates at once, as the health checker does, leave the last state and a valid file', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `wa-${i}`);
    const repository = new InMemoryAccountRepository(ids.map(account), path);

    await Promise.all(ids.map((id) => repository.update(id, { alias: `renamed-${id}` })));

    const loaded = loadAccountsFromYaml(path);
    expect(loaded.map((a) => a.alias)).toEqual(ids.map((id) => `renamed-${id}`));
  });

  it('writes one at a time, each through a temporary file that ends up renamed', async () => {
    const original = vi.mocked(fsPromises.rename).getMockImplementation()!;
    let active = 0;
    let most = 0;
    vi.mocked(fsPromises.rename).mockImplementation(async (from, to) => {
      active += 1;
      most = Math.max(most, active);
      await new Promise((r) => setTimeout(r, 5));
      await original(from, to);
      active -= 1;
    });
    const repository = new InMemoryAccountRepository([account('wa-1')], path);

    try {
      await Promise.all([1, 2, 3, 4].map((n) => repository.update('wa-1', { alias: `alias-${n}` })));
    } finally {
      vi.mocked(fsPromises.rename).mockImplementation(original);
    }

    expect(most).toBe(1);
    expect(fsPromises.rename).toHaveBeenCalledTimes(4);
    expect(await readdir(join(dir, 'nested'))).toEqual(['accounts.yaml']);
    expect(await readFile(path, 'utf-8')).toContain('alias-4');
  });

  it('flushes the directory after the rename, so a power cut cannot bring the old file back', async () => {
    const repository = new InMemoryAccountRepository([], path);

    await repository.save(account('wa-1'));

    const openedDirectory = vi.mocked(fsPromises.open).mock.calls.findIndex(([opened]) => opened === dirname(path));
    expect(openedDirectory).toBeGreaterThanOrEqual(0);
    expect(vi.mocked(fsPromises.open).mock.invocationCallOrder[openedDirectory])
      .toBeGreaterThan(vi.mocked(fsPromises.rename).mock.invocationCallOrder[0]!);
  });

  describe('a write that fails', () => {
    /** What a start would load from the file, against what the running gateway holds. */
    const inStep = async (repository: InMemoryAccountRepository) => {
      expect((await repository.findAll()).map((a) => [a.id, a.alias])).toEqual(loadAccountsFromYaml(path).map((a) => [a.id, a.alias]));
    };

    async function onDisk(): Promise<InMemoryAccountRepository> {
      vi.mocked(fsPromises.rename).mockReset();
      const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      vi.mocked(fsPromises.rename).mockImplementation(original.rename);
      const repository = new InMemoryAccountRepository([], path);
      await repository.save(account('wa-1'));
      vi.mocked(fsPromises.rename).mockRejectedValueOnce(new Error('disk full'));
      return repository;
    }

    it('rejects a save, and the account is not there', async () => {
      const repository = await onDisk();

      await expect(repository.save(account('wa-2'))).rejects.toThrow('disk full');

      expect(await repository.findById('wa-2')).toBeUndefined();
      await inStep(repository);
    });

    it('rejects an update, and the account stays as it was', async () => {
      const repository = await onDisk();

      await expect(repository.update('wa-1', { alias: 'lost' })).rejects.toThrow('disk full');

      expect((await repository.findById('wa-1'))?.alias).toBe('wa-1');
      await inStep(repository);
    });

    it('rejects a removal, and the account is still there', async () => {
      const repository = await onDisk();

      await expect(repository.remove('wa-1')).rejects.toThrow('disk full');

      expect(await repository.findById('wa-1')).toBeDefined();
      await inStep(repository);
    });

    it('keeps the previous file, and the next one goes through without what failed', async () => {
      const repository = await onDisk();

      await expect(repository.update('wa-1', { alias: 'lost' })).rejects.toThrow();
      expect(await readFile(path, 'utf-8')).not.toContain('lost');

      await repository.update('wa-1', { alias: 'second' });
      expect(await readFile(path, 'utf-8')).toContain('second');
      expect(await readdir(join(dir, 'nested'))).toEqual(['accounts.yaml']);
      await inStep(repository);
    });

    it('does not spoil the writes queued behind it', async () => {
      const repository = await onDisk();

      const results = await Promise.allSettled([
        repository.update('wa-1', { alias: 'lost' }),
        repository.update('wa-1', { conversations: ['123@g.us'] }),
      ]);

      expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled']);
      expect(await repository.findById('wa-1')).toMatchObject({ alias: 'wa-1', conversations: ['123@g.us'] });
      expect(loadAccountsFromYaml(path)[0]).toMatchObject({ alias: 'wa-1', conversations: ['123@g.us'] });
    });
  });
});
