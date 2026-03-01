import { createHmac } from 'node:crypto';
import type { UnifiedEnvelope } from '../domain/messaging/unified-envelope.js';
import type { WebhookConfigRepository } from '../domain/webhooks/webhook-config.repository.js';
import type { WebhookEventType } from '../domain/webhooks/webhook-config.js';

export class WebhookForwarder {
  constructor(
    private readonly webhookConfigRepo: WebhookConfigRepository,
    private readonly globalCallbackUrl: string | undefined,
    private readonly globalSecret: string | undefined,
  ) {}

  async forward(envelope: UnifiedEnvelope, eventType: WebhookEventType = 'message.inbound'): Promise<void> {
    const accountConfig = await this.webhookConfigRepo.findByAccountId(envelope.accountId);

    if (accountConfig?.enabled) {
      const matchesEvent = accountConfig.events.includes('*') || accountConfig.events.includes(eventType);
      if (matchesEvent) {
        await this.send(accountConfig.url, accountConfig.secret, envelope, eventType);
        return;
      }
    }

    // Global fallback
    if (this.globalCallbackUrl) {
      await this.send(this.globalCallbackUrl, this.globalSecret, envelope, eventType);
    }
  }

  private async send(
    url: string,
    secret: string | undefined,
    envelope: UnifiedEnvelope,
    eventType: WebhookEventType,
  ): Promise<void> {
    const payload = JSON.stringify(envelope);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-UMG-Event': eventType,
      'X-UMG-Channel': envelope.channel,
      'X-UMG-Account': envelope.accountId,
    };

    if (secret) {
      const signature = createHmac('sha256', secret)
        .update(payload)
        .digest('hex');
      headers['X-UMG-Signature'] = `sha256=${signature}`;
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: payload,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        console.error(
          `Webhook forwarding failed for ${envelope.accountId}: HTTP ${response.status} - ${text}`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Webhook forwarding error for ${envelope.accountId}: ${message}`);
    }
  }
}
