import type { WebhookConfig, WebhookConfigInput } from './webhook-config.js';

export interface WebhookConfigRepository {
  /** Get all webhooks for an account */
  findByAccountId(accountId: string): Promise<WebhookConfig[]>;
  /** Get a specific webhook by ID */
  findById(webhookId: string): Promise<WebhookConfig | undefined>;
  /** Get all webhooks across all accounts */
  findAll(): Promise<WebhookConfig[]>;
  /** Add a new webhook to an account (returns created config with generated ID) */
  add(accountId: string, input: WebhookConfigInput): Promise<WebhookConfig>;
  /** Update an existing webhook */
  update(webhookId: string, input: Partial<WebhookConfigInput>): Promise<WebhookConfig | undefined>;
  /** Remove a specific webhook */
  remove(webhookId: string): Promise<boolean>;
  /** Remove all webhooks for an account */
  removeByAccountId(accountId: string): Promise<number>;
}
