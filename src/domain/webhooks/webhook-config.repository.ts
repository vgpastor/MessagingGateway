import type { WebhookConfig, WebhookConfigInput } from './webhook-config.js';

export interface WebhookConfigRepository {
  findByAccountId(accountId: string): Promise<WebhookConfig | undefined>;
  findAll(): Promise<WebhookConfig[]>;
  upsert(accountId: string, input: WebhookConfigInput): Promise<WebhookConfig>;
  remove(accountId: string): Promise<boolean>;
}
