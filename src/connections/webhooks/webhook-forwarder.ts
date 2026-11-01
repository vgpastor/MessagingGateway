import { createHmac } from 'node:crypto';
import { getLogger } from '../../core/logger/logger.port.js';
import type { UnifiedEnvelope } from '../../core/messaging/unified-envelope.js';
import type { WebhookConfigRepository } from '../../core/webhooks/webhook-config.repository.js';
import type { WebhookEventType } from '../../core/webhooks/webhook-config.js';
import { matchesFilter } from '../../core/filters/envelope-filter.js';
import type { MetricsPort } from '../../core/metrics/metrics.port.js';
import { noopMetrics } from '../../core/metrics/metrics.port.js';

/** Longest a webhook may take to answer. A hung endpoint only ever holds back its own queue. */
export const WEBHOOK_TIMEOUT_MS = 10_000;

/** Events waiting per destination. A consumer that loses some catches up with `GET /api/v1/messages?afterAccountSeq=`. */
export const WEBHOOK_QUEUE_CAPACITY = 1000;

/** How much of a failed answer reaches the log: it is whatever the destination chose to send. */
export const WEBHOOK_ERROR_TEXT_LIMIT = 500;

interface QueuedDelivery {
  url: string;
  accountId: string;
  eventType: WebhookEventType;
  headers: Record<string, string>;
  body: string;
  /** Told once whether the destination answered 2xx; a delivery dropped from a full queue did not. */
  onSettled?: (delivered: boolean) => void;
}

interface DestinationQueue {
  pending: QueuedDelivery[];
  /** Sends `pending` one at a time, in order; settles once it is empty. Never rejects. */
  worker: Promise<void>;
}

/** A webhook URL often carries its secret in the path or the query, so logs name the host and nothing else. */
export function destinationHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}

/**
 * Forwards events to webhooks from an in-memory queue per destination: `forward` and `send`
 * only enqueue, so the caller never waits for a webhook and a slow destination delays no other.
 */
export class WebhookForwarder {
  private readonly queues = new Map<string, DestinationQueue>();

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
      for (const c of matching) this.sendGuarded(c.url, c.secret, accountId, payload, eventType, channel);
      return;
    }

    // Global fallback (only if no account-specific webhooks matched)
    if (this.globalCallbackUrl) {
      this.sendGuarded(this.globalCallbackUrl, this.globalSecret, accountId, payload, eventType, channel);
    }
  }

  /** Queue one event for a destination. The body is serialized now: later changes to `data` do not reach it. */
  send(
    url: string,
    secret: string | undefined,
    accountId: string,
    data: unknown,
    eventType: WebhookEventType,
    channel?: string,
  ): void {
    this.enqueue(this.buildDelivery(url, secret, accountId, data, eventType, channel));
  }

  /** Like {@link send}, for whoever must know: resolves to whether the destination answered 2xx. Never rejects. */
  sendConfirmed(
    url: string,
    secret: string | undefined,
    accountId: string,
    data: unknown,
    eventType: WebhookEventType,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        this.enqueue({ ...this.buildDelivery(url, secret, accountId, data, eventType), onSettled: resolve });
      } catch (err) {
        this.recordUnserializable(url, accountId, eventType, err);
        resolve(false);
      }
    });
  }

  /** A payload that cannot be serialized costs its own delivery, not the other destinations. */
  private sendGuarded(
    url: string,
    secret: string | undefined,
    accountId: string,
    data: unknown,
    eventType: WebhookEventType,
    channel?: string,
  ): void {
    try {
      this.send(url, secret, accountId, data, eventType, channel);
    } catch (err) {
      this.recordUnserializable(url, accountId, eventType, err);
    }
  }

  private recordUnserializable(url: string, accountId: string, eventType: WebhookEventType, err: unknown): void {
    this.metrics.incCounter('umg_webhook_failures_total', { account: accountId });
    getLogger().error('Webhook payload could not be serialized', {
      accountId, eventType, host: destinationHost(url), error: err instanceof Error ? err.message : String(err),
    });
  }

  private buildDelivery(
    url: string,
    secret: string | undefined,
    accountId: string,
    data: unknown,
    eventType: WebhookEventType,
    channel?: string,
  ): QueuedDelivery {
    const body = JSON.stringify(data);
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
        .update(body)
        .digest('hex');
      headers['X-UMG-Signature'] = `sha256=${signature}`;
    }

    return { url, accountId, eventType, headers, body };
  }

  /** Resolves once every queue is empty. Bound the wait on the caller's side: a hung destination takes its time. */
  async drain(): Promise<void> {
    while (this.queues.size > 0) {
      await Promise.all([...this.queues.values()].map((queue) => queue.worker));
    }
  }

  private enqueue(delivery: QueuedDelivery): void {
    const queue = this.queues.get(delivery.url);
    if (!queue) {
      const created: DestinationQueue = { pending: [delivery], worker: Promise.resolve() };
      this.queues.set(delivery.url, created);
      created.worker = this.deliverAll(delivery.url, created);
      return;
    }

    if (queue.pending.length >= WEBHOOK_QUEUE_CAPACITY) {
      const oldest = queue.pending.shift();
      oldest?.onSettled?.(false);
      this.metrics.incCounter('umg_webhook_dropped_total', { account: oldest?.accountId ?? delivery.accountId });
      getLogger().error('Webhook queue full, dropped the oldest event', {
        accountId: oldest?.accountId, eventType: oldest?.eventType, host: destinationHost(delivery.url), capacity: WEBHOOK_QUEUE_CAPACITY,
      });
    }
    queue.pending.push(delivery);
  }

  private async deliverAll(url: string, queue: DestinationQueue): Promise<void> {
    for (let next = queue.pending.shift(); next; next = queue.pending.shift()) {
      const delivered = await this.post(next);
      next.onSettled?.(delivered);
    }
    this.queues.delete(url);
  }

  /** Whether the destination answered 2xx. Never rejects. */
  private async post({ url, accountId, headers, body }: QueuedDelivery): Promise<boolean> {
    const start = performance.now();
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });

      const durationInSeconds = (performance.now() - start) / 1000;
      this.metrics.observeHistogram('umg_webhook_forward_duration_seconds', durationInSeconds, { account: accountId, status: String(response.status) });

      if (response.ok) {
        // Nobody reads it, and an unread body keeps its connection out of the pool. It was delivered either way.
        await response.body?.cancel().catch(() => {});
        return true;
      }

      this.metrics.incCounter('umg_webhook_failures_total', { account: accountId });
      const text = await response.text().catch(() => '');
      getLogger().error('Webhook forwarding failed', {
        accountId, host: destinationHost(url), httpStatus: response.status, response: text.slice(0, WEBHOOK_ERROR_TEXT_LIMIT),
      });
      return false;
    } catch (err) {
      const durationInSeconds = (performance.now() - start) / 1000;
      this.metrics.observeHistogram('umg_webhook_forward_duration_seconds', durationInSeconds, { account: accountId, status: 'error' });
      this.metrics.incCounter('umg_webhook_failures_total', { account: accountId });
      const host = destinationHost(url);
      // fetch quotes the whole URL when it cannot parse it.
      const message = (err instanceof Error ? err.message : String(err)).replaceAll(url, host);
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      getLogger().error(timedOut ? 'Webhook forwarding timed out' : 'Webhook forwarding error', {
        accountId, host, error: message, ...(timedOut ? { timeoutMs: WEBHOOK_TIMEOUT_MS } : {}),
      });
      return false;
    }
  }
}
