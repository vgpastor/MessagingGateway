import { createHmac } from 'node:crypto';
import type { UnifiedEnvelope } from '../../core/messaging/unified-envelope.js';
import type { WebhookConfigRepository } from '../../core/webhooks/webhook-config.repository.js';
import type { WebhookEventType } from '../../core/webhooks/webhook-config.js';
import { matchesFilter } from '../../core/filters/envelope-filter.js';

export class WebhookForwarder {
  constructor(
    private readonly webhookConfigRepo: WebhookConfigRepository,
    private readonly globalCallbackUrl: string | undefined,
    private readonly globalSecret: string | undefined,
  ) {}

  async forward(envelope: UnifiedEnvelope, eventType: WebhookEventType = 'message.inbound'): Promise<void> {
    await this.forwardRaw(envelope.accountId, envelope, eventType, envelope.channel);
  }

  async forwardRaw(
    accountId: string,
    payload: unknown,
    eventType: WebhookEventType,
    channel?: string,
  ): Promise<void> {
    const accountConfigs = await this.webhookConfigRepo.findByAccountId(accountId);

    // Filter: enabled + event type match + envelope filter match
    const payloadObj = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
    const matching = accountConfigs.filter((c) =>
      c.enabled
      && (c.events.includes('*') || c.events.includes(eventType))
      && matchesFilter(payloadObj, c.filters),
    );

    if (matching.length > 0) {
      // Send to all matching webhooks in parallel
      await Promise.allSettled(
        matching.map((c) => this.send(c.url, c.secret, accountId, payload, eventType, channel)),
      );
      return;
    }

    // Global fallback (only if no account-specific webhooks matched)
    if (this.globalCallbackUrl) {
      await this.send(this.globalCallbackUrl, this.globalSecret, accountId, payload, eventType, channel);
    }
  }

  private async send(
    url: string,
    secret: string | undefined,
    accountId: string,
    data: unknown,
    eventType: WebhookEventType,
    channel?: string,
  ): Promise<void> {
    const payload = JSON.stringify(data);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-UMG-Event': eventType,
      'X-UMG-Account': accountId,
    };
    if (channel) {
      headers['X-UMG-Channel'] = channel;
    }

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
        console.error(`Webhook forwarding failed for ${accountId} → ${url}: HTTP ${response.status} - ${text}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Webhook forwarding error for ${accountId} → ${url}: ${message}`);
    }
  }
}
