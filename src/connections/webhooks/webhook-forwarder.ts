import { createHmac } from 'node:crypto';
import { getLogger } from '../../core/logger/logger.port.js';
import type { UnifiedEnvelope } from '../../core/messaging/unified-envelope.js';
import type { WebhookConfigRepository } from '../../core/webhooks/webhook-config.repository.js';
import type { WebhookEventType } from '../../core/webhooks/webhook-config.js';
import { matchesFilter } from '../../core/filters/envelope-filter.js';
import type { MetricsPort } from '../../core/metrics/metrics.port.js';
import { noopMetrics } from '../../core/metrics/metrics.port.js';

/**
 * Longest a webhook may take to answer. Inbound events are emitted per account in order and the emit
 * awaits its handlers, so a hung endpoint would otherwise block that account's ingestion forever.
 */
export const WEBHOOK_TIMEOUT_MS = 10_000;

export class WebhookForwarder {
  constructor(
    private readonly webhookConfigRepo: WebhookConfigRepository,
    private readonly globalCallbackUrl: string | undefined,
    private readonly globalSecret: string | undefined,
    private readonly metrics: MetricsPort = noopMetrics,
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

  async send(
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

    const start = performance.now();
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: payload,
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });

      const durationInSeconds = (performance.now() - start) / 1000;
      this.metrics.observeHistogram('umg_webhook_forward_duration_seconds', durationInSeconds, { account: accountId, status: String(response.status) });

      if (!response.ok) {
        this.metrics.incCounter('umg_webhook_failures_total', { account: accountId });
        const text = await response.text().catch(() => '');
        getLogger().error('Webhook forwarding failed', { accountId, url, httpStatus: response.status, response: text });
      }
    } catch (err) {
      const durationInSeconds = (performance.now() - start) / 1000;
      this.metrics.observeHistogram('umg_webhook_forward_duration_seconds', durationInSeconds, { account: accountId, status: 'error' });
      this.metrics.incCounter('umg_webhook_failures_total', { account: accountId });
      const message = err instanceof Error ? err.message : String(err);
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      getLogger().error(timedOut ? 'Webhook forwarding timed out' : 'Webhook forwarding error', {
        accountId, url, error: message, ...(timedOut ? { timeoutMs: WEBHOOK_TIMEOUT_MS } : {}),
      });
    }
  }
}
