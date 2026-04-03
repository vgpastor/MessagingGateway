import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { WebhookConfig, WebhookConfigInput } from '../../core/webhooks/webhook-config.js';
import { createWebhookId } from '../../core/webhooks/webhook-config.js';
import type { WebhookConfigRepository } from '../../core/webhooks/webhook-config.repository.js';

export class FileWebhookConfigStore implements WebhookConfigRepository {
  private configs: WebhookConfig[] = [];
  private readonly filePath: string;

  private constructor(filePath: string) {
    this.filePath = filePath;
  }

  static async create(filePath: string): Promise<FileWebhookConfigStore> {
    const store = new FileWebhookConfigStore(filePath);
    await store.load();
    return store;
  }

  async findByAccountId(accountId: string): Promise<WebhookConfig[]> {
    return this.configs.filter((c) => c.accountId === accountId);
  }

  async findById(webhookId: string): Promise<WebhookConfig | undefined> {
    return this.configs.find((c) => c.id === webhookId);
  }

  async findAll(): Promise<WebhookConfig[]> {
    return [...this.configs];
  }

  async add(accountId: string, input: WebhookConfigInput): Promise<WebhookConfig> {
    const now = new Date().toISOString();
    const config: WebhookConfig = {
      id: createWebhookId(),
      accountId,
      url: input.url,
      secret: input.secret,
      events: input.events?.length ? input.events : ['*'],
      filters: input.filters,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };

    this.configs.push(config);
    await this.persist();
    return config;
  }

  async update(webhookId: string, input: Partial<WebhookConfigInput>): Promise<WebhookConfig | undefined> {
    const config = this.configs.find((c) => c.id === webhookId);
    if (!config) return undefined;

    if (input.url !== undefined) config.url = input.url;
    if (input.secret !== undefined) config.secret = input.secret;
    if (input.events !== undefined) config.events = input.events.length ? input.events : ['*'];
    if (input.filters !== undefined) config.filters = input.filters;
    if (input.enabled !== undefined) config.enabled = input.enabled;
    config.updatedAt = new Date().toISOString();

    await this.persist();
    return config;
  }

  async remove(webhookId: string): Promise<boolean> {
    const idx = this.configs.findIndex((c) => c.id === webhookId);
    if (idx === -1) return false;
    this.configs.splice(idx, 1);
    await this.persist();
    return true;
  }

  async removeByAccountId(accountId: string): Promise<number> {
    const before = this.configs.length;
    this.configs = this.configs.filter((c) => c.accountId !== accountId);
    const removed = before - this.configs.length;
    if (removed > 0) await this.persist();
    return removed;
  }

  private async load(): Promise<void> {
    if (!existsSync(this.filePath)) return;

    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const data = JSON.parse(raw) as WebhookConfig[];
      // Migration: add id to old configs that don't have one
      this.configs = data.map((c) => ({
        ...c,
        id: c.id || createWebhookId(),
      }));
    } catch {
      console.warn(`Failed to load webhook configs from ${this.filePath}, starting fresh`);
    }
  }

  private async persist(): Promise<void> {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(this.filePath, JSON.stringify(this.configs, null, 2), 'utf-8');
  }
}
