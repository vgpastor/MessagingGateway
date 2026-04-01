import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { WebhookConfig, WebhookConfigInput } from '../../core/webhooks/webhook-config.js';
import type { WebhookConfigRepository } from '../../core/webhooks/webhook-config.repository.js';

export class FileWebhookConfigStore implements WebhookConfigRepository {
  private configs: Map<string, WebhookConfig>;
  private readonly filePath: string;

  private constructor(filePath: string) {
    this.filePath = filePath;
    this.configs = new Map();
  }

  static async create(filePath: string): Promise<FileWebhookConfigStore> {
    const store = new FileWebhookConfigStore(filePath);
    await store.load();
    return store;
  }

  async findByAccountId(accountId: string): Promise<WebhookConfig | undefined> {
    return this.configs.get(accountId);
  }

  async findAll(): Promise<WebhookConfig[]> {
    return [...this.configs.values()];
  }

  async upsert(accountId: string, input: WebhookConfigInput): Promise<WebhookConfig> {
    const now = new Date().toISOString();
    const existing = this.configs.get(accountId);

    const config: WebhookConfig = {
      accountId,
      url: input.url,
      secret: input.secret,
      events: input.events && input.events.length > 0 ? input.events : ['*'],
      enabled: input.enabled ?? true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.configs.set(accountId, config);
    await this.persist();
    return config;
  }

  async remove(accountId: string): Promise<boolean> {
    const deleted = this.configs.delete(accountId);
    if (deleted) {
      await this.persist();
    }
    return deleted;
  }

  private async load(): Promise<void> {
    if (!existsSync(this.filePath)) {
      return;
    }

    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const data = JSON.parse(raw) as WebhookConfig[];
      for (const config of data) {
        this.configs.set(config.accountId, config);
      }
    } catch {
      console.warn(`Failed to load webhook configs from ${this.filePath}, starting fresh`);
    }
  }

  private async persist(): Promise<void> {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    const data = [...this.configs.values()];
    await writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
  }
}
