import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { getLogger } from '../../core/logger/logger.port.js';
import type { ChannelType } from '../../core/messaging/channel.types.js';
import type { ChannelAccount } from '../../core/accounts/channel-account.js';
import type { ChannelAccountRepository } from '../../core/accounts/channel-account.repository.js';
import { matchesRoutingCriteria } from '../../core/routing/routing-rules.js';

export class InMemoryAccountRepository implements ChannelAccountRepository {
  private accounts: ChannelAccount[];
  private readonly persistPath?: string;

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

  async save(account: ChannelAccount): Promise<ChannelAccount> {
    const existing = this.accounts.findIndex((a) => a.id === account.id);
    if (existing !== -1) {
      throw new Error(`Account '${account.id}' already exists`);
    }
    this.accounts.push(account);
    this.persist();
    return account;
  }

  async update(id: string, partial: Partial<Omit<ChannelAccount, 'id'>>): Promise<ChannelAccount | undefined> {
    const index = this.accounts.findIndex((a) => a.id === id);
    if (index === -1) {
      return undefined;
    }

    const current = this.accounts[index]!;
    const updated: ChannelAccount = {
      ...current,
      ...partial,
      id: current.id,
      metadata: partial.metadata
        ? { ...current.metadata, ...partial.metadata }
        : current.metadata,
    };

    this.accounts[index] = updated;
    this.persist();
    return updated;
  }

  async remove(id: string): Promise<boolean> {
    const index = this.accounts.findIndex((a) => a.id === id);
    if (index === -1) {
      return false;
    }
    this.accounts.splice(index, 1);
    this.persist();
    return true;
  }

  private persist(): void {
    if (!this.persistPath) return;

    const data = {
      accounts: this.accounts.map((a) => ({
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
        metadata: {
          owner: a.metadata.owner,
          environment: a.metadata.environment,
          ...(a.metadata.webhookPath ? { webhookPath: a.metadata.webhookPath } : {}),
          ...(a.metadata.rateLimit ? { rateLimit: a.metadata.rateLimit } : {}),
          tags: a.metadata.tags,
        },
      })),
    };

    const path = this.persistPath;
    mkdir(dirname(path), { recursive: true })
      .then(() => writeFile(path, stringifyYaml(data), 'utf-8'))
      .catch((err) => {
        getLogger().warn('Failed to persist accounts', { path, error: (err as Error).message });
      });
  }

  private serializeIdentity(account: ChannelAccount): Record<string, unknown> {
    const identity = account.identity as unknown as Record<string, unknown>;
    const { channel: _, ...rest } = identity;
    return rest;
  }
}
