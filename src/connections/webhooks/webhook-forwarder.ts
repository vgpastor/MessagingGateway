import { createHmac } from 'node:crypto';
import { getLogger } from '../../core/logger/logger.port.js';
import type { UnifiedEnvelope } from '../../core/messaging/unified-envelope.js';
import type { WebhookConfigRepository } from '../../core/webhooks/webhook-config.repository.js';
import type { WebhookEventType } from '../../core/webhooks/webhook-config.js';
import { matchesFilter } from '../../core/filters/envelope-filter.js';
import { webhookForwardDuration } from '../../infrastructure/metrics/prometheus.js';

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
    const matching = accountConfigs.filter((c) => {
      if (!c.enabled) return false;
      if (!c.events.includes('*') && !c.events.includes(eventType)) return false;
      // Only apply envelope filters for message events (not status/raw payloads)
      if (c.filters && (eventType === 'message.inbound' || eventType === 'message.sent')) {
        return matchesFilter(payloadObj, c.filters);
      }
      return true;
    });

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

    const end = webhookForwardDuration.startTimer({ account: accountId, url });
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: payload,
      });

      end({ status: String(response.status) });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        getLogger().error('Webhook forwarding failed', { accountId, url, httpStatus: response.status, response: text });
      }
    } catch (err) {
      end({ status: 'error' });
      const message = err instanceof Error ? err.message : String(err);
      getLogger().error('Webhook forwarding error', { accountId, url, error: message });
    }
  }
}
