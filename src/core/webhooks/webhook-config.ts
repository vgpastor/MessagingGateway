import { randomUUID } from 'node:crypto';
import type { EnvelopeFilter } from '../filters/envelope-filter.js';

export type WebhookEventType =
  | 'message.inbound'
  | 'message.status'
  | 'message.sent'
  | '*';

export interface WebhookConfig {
  id: string;
  accountId: string;
  url: string;
  secret?: string;
  events: WebhookEventType[];
  filters?: EnvelopeFilter;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookConfigInput {
  url: string;
  secret?: string;
  events?: WebhookEventType[];
  filters?: EnvelopeFilter;
  enabled?: boolean;
}

export function createWebhookId(): string {
  return `wh_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}
