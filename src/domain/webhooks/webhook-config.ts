export type WebhookEventType =
  | 'message.inbound'
  | 'message.status'
  | 'message.sent'
  | '*';

export interface WebhookConfig {
  accountId: string;
  url: string;
  secret?: string;
  events: WebhookEventType[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookConfigInput {
  url: string;
  secret?: string;
  events?: WebhookEventType[];
  enabled?: boolean;
}
