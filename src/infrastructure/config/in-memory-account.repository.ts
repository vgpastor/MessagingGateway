import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { AccountAlreadyExistsError } from '../../core/errors.js';
import type { ChannelType } from '../../core/messaging/channel.types.js';
import type { ChannelAccount } from '../../core/accounts/channel-account.js';
import type { ChannelAccountRepository } from '../../core/accounts/channel-account.repository.js';
import { matchesRoutingCriteria } from '../../core/routing/routing-rules.js';
import { syncDirectory } from '../fs/sync-directory.js';

export class InMemoryAccountRepository implements ChannelAccountRepository {
  private accounts: ChannelAccount[];
  private readonly persistPath?: string;
  /** The write in progress: the next one starts when it ends, so two can never interleave in the file. */
  private lastWrite: Promise<void> = Promise.resolve();

  constructor(accounts: ChannelAccount[], persistPath?: string) {
    this.accounts = accounts;
    this.persistPath = persistPath;
  }

  async findById(id: string): Promise<ChannelAccount | undefined> {
    return this.accounts.find((a) => a.id === id);
  }

  async findAll(): Promise<ChannelAccount[]> {
    return [...this.accounts];
  }

  async findByChannel(channel: ChannelType): Promise<ChannelAccount[]> {
    return this.accounts.filter((a) => a.channel === channel);
  }

  async findByOwner(owner: string): Promise<ChannelAccount[]> {
    return this.accounts.filter((a) => a.metadata.owner === owner);
  }

  async findByTags(tags: string[]): Promise<ChannelAccount[]> {
    return this.accounts.filter((a) =>
      tags.every((tag) => a.metadata.tags.includes(tag)),
    );
  }

  async findByRoutingRules(criteria: {
    channel?: string;
    owner?: string;
    tags?: string[];
  }): Promise<ChannelAccount | undefined> {
    return this.accounts.find(
      (a) => a.status === 'active' && matchesRoutingCriteria(a, criteria),
    );
  }

  save(account: ChannelAccount): Promise<ChannelAccount> {
    return this.commit((accounts) => {
      if (accounts.some((a) => a.id === account.id)) {
        throw new AccountAlreadyExistsError(account.id);
      }
      return { accounts: [...accounts, account], result: account };
    });
  }

  update(id: string, partial: Partial<Omit<ChannelAccount, 'id'>>): Promise<ChannelAccount | undefined> {
    return this.commit((accounts) => {
      const current = accounts.find((a) => a.id === id);
      if (!current) return { accounts, result: undefined };

      const updated: ChannelAccount = {
        ...current,
        ...partial,
        id: current.id,
        metadata: partial.metadata
          ? { ...current.metadata, ...partial.metadata }
          : current.metadata,
      };
      return { accounts: accounts.map((a) => (a === current ? updated : a)), result: updated };
    });
  }

  remove(id: string): Promise<boolean> {
    return this.commit((accounts) => {
      const remaining = accounts.filter((a) => a.id !== id);
      return remaining.length === accounts.length ? { accounts, result: false } : { accounts: remaining, result: true };
    });
  }

  /**
   * Applies a change once it is on disk, so what is in memory is what the next start would load: a write that fails
   * rejects and changes nothing. Changes wait for the one in progress and start from its outcome, one at a time.
   */
  private commit<T>(change: (accounts: ChannelAccount[]) => { accounts: ChannelAccount[]; result: T }): Promise<T> {
    const run = this.lastWrite.then(async () => {
      const { accounts, result } = change(this.accounts);
      if (accounts !== this.accounts) {
        if (this.persistPath) await this.writeAtomically(this.persistPath, this.toYaml(accounts));
        this.accounts = accounts;
      }
      return result;
    });
    this.lastWrite = run.then(() => {}, () => {});
    return run;
  }

  private toYaml(accounts: ChannelAccount[]): string {
    const data = {
      accounts: accounts.map((a) => ({
        id: a.id,
        alias: a.alias,
        channel: a.channel,
        provider: a.provider,
        ...(a.status !== 'unchecked' ? { status: a.status } : {}),
        identity: this.serializeIdentity(a),
        ...(a.credentialsRef ? { credentialsRef: a.credentialsRef } : {}),
        ...(a.credentials ? { credentials: a.credentials } : {}),
        ...(Object.keys(a.providerConfig).length > 0
          ? { providerConfig: a.providerConfig }
          : {}),
        ...(a.conversations && a.conversations !== '*' ? { conversations: a.conversations } : {}),
        metadata: {
          owner: a.metadata.owner,
          environment: a.metadata.environment,
          ...(a.metadata.webhookPath ? { webhookPath: a.metadata.webhookPath } : {}),
          ...(a.metadata.rateLimit ? { rateLimit: a.metadata.rateLimit } : {}),
          tags: a.metadata.tags,
        },
      })),
    };

    return stringifyYaml(data);
  }

  /**
   * A file cut halfway would stop the next start, so the old one stays until the new one is complete and on
   * disk, and the directory is flushed so the new one stays after a power cut. It holds credentials: only the owner can read it.
   */
  private async writeAtomically(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    try {
      const file = await open(tmp, 'w', 0o600);
      try {
        await file.writeFile(content, 'utf-8');
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(tmp, path);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    await syncDirectory(dirname(path));
  }

  private serializeIdentity(account: ChannelAccount): Record<string, unknown> {
    const identity = account.identity as unknown as Record<string, unknown>;
    const { channel: _, ...rest } = identity;
    return rest;
  }
}
