import { describe, it, expect, vi, afterEach } from 'vitest';
import { WebhookForwarder, WEBHOOK_QUEUE_CAPACITY } from '../../../src/connections/webhooks/webhook-forwarder.js';
import { EventBus } from '../../../src/core/event-bus.js';
import { Events } from '../../../src/core/events.js';
import type { MessageInboundPayload } from '../../../src/core/events.js';
import type { ChannelAccount } from '../../../src/core/accounts/channel-account.js';
import { InboundPipeline } from '../../../src/core/inbound/inbound-pipeline.js';
import { noopMediaService } from '../../../src/core/inbound/media-service.js';
import { noopMetrics } from '../../../src/core/metrics/metrics.port.js';
import type { UnifiedEnvelope } from '../../../src/core/messaging/unified-envelope.js';
import type { WebhookConfigRepository } from '../../../src/core/webhooks/webhook-config.repository.js';
import { PrometheusMetrics } from '../../../src/infrastructure/metrics/prometheus-metrics.js';
import { registry } from '../../../src/infrastructure/metrics/prometheus.js';
import { SqliteMessageStore } from '../../../src/persistence/sqlite-message-store.js';

const noConfigs = { findByAccountId: async () => [] } as unknown as WebhookConfigRepository;

/** A fetch whose answers the test releases by hand, per call. */
function manualFetch() {
  const calls: Array<{ url: string; body: string; answer: () => void }> = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => new Promise((resolve) => {
    calls.push({ url, body: String(init.body), answer: () => resolve(new Response('ok', { status: 200 })) });
  })));
  return calls;
}

const flush = () => new Promise((r) => setImmediate(r));

function envelope(id: string): UnifiedEnvelope {
  const now = new Date('2026-05-01T10:00:00Z');
  return {
    id,
    accountId: 'wa-1',
    channel: 'whatsapp',
    direction: 'inbound',
    timestamp: now,
    conversationId: 'c@s.whatsapp.net',
    sender: { id: 's@s.whatsapp.net' },
    recipient: { id: '+34600000001' },
    content: { type: 'text', body: id },
    channelDetails: { platform: 'whatsapp', messageId: id },
    gateway: { receivedAt: now, adapterId: 'baileys', account: { id: 'wa-1', alias: 'a', owner: 'o', tags: [] } },
  };
}

describe('WebhookForwarder delivery queues', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('forward() does not wait for the webhook to answer', async () => {
    const calls = manualFetch();
    const forwarder = new WebhookForwarder(noConfigs, 'https://hook.example.com', undefined);

    await forwarder.forward(envelope('m1'));

    expect(calls).toHaveLength(1);
    calls[0]!.answer();
    await forwarder.drain();
  });

  it('sends to one destination one at a time, in order', async () => {
    const calls = manualFetch();
    const forwarder = new WebhookForwarder(noConfigs, 'https://hook.example.com', undefined);

    await forwarder.forward(envelope('m1'));
    await forwarder.forward(envelope('m2'));
    await forwarder.forward(envelope('m3'));
    expect(calls).toHaveLength(1);

    calls[0]!.answer();
    await flush();
    expect(calls).toHaveLength(2);
    calls[1]!.answer();
    await flush();
    calls[2]!.answer();
    await forwarder.drain();

    expect(calls.map((c) => JSON.parse(c.body).id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('a destination that hangs delays no other destination', async () => {
    const calls = manualFetch();
    const forwarder = new WebhookForwarder(noConfigs, undefined, undefined);

    forwarder.send('https://hung.example.com', undefined, 'wa-1', { n: 1 }, 'message.inbound');
    forwarder.send('https://hung.example.com', undefined, 'wa-1', { n: 2 }, 'message.inbound');
    forwarder.send('https://healthy.example.com', undefined, 'wa-1', { n: 3 }, 'message.inbound');

    expect(calls.map((c) => c.url)).toEqual(['https://hung.example.com', 'https://healthy.example.com']);
    calls[0]!.answer();
    calls[1]!.answer();
    await flush();
    calls[2]!.answer();
    await forwarder.drain();
  });

  it('when a queue is full drops the oldest events, counting them without exposing the URL', async () => {
    registry.resetMetrics();
    const calls = manualFetch();
    const forwarder = new WebhookForwarder(noConfigs, undefined, undefined, new PrometheusMetrics());
    const url = 'https://hook.example.com/in?token=SECRET';

    // The first one is in flight; then the queue fills up and overflows by two.
    for (let n = 0; n < WEBHOOK_QUEUE_CAPACITY + 3; n++) {
      forwarder.send(url, undefined, 'wa-1', { n }, 'message.inbound');
    }

    const metrics = await registry.metrics();
    expect(metrics).toContain('umg_webhook_dropped_total{account="wa-1"} 2');
    expect(metrics).not.toContain('SECRET');

    const delivered: number[] = [];
    for (let i = 0; i <= WEBHOOK_QUEUE_CAPACITY; i++) {
      delivered.push(JSON.parse(calls[i]!.body).n);
      calls[i]!.answer();
      await flush();
    }
    await forwarder.drain();

    expect(delivered.slice(0, 3)).toEqual([0, 3, 4]);
    expect(delivered.at(-1)).toBe(WEBHOOK_QUEUE_CAPACITY + 2);
    expect(delivered).toHaveLength(WEBHOOK_QUEUE_CAPACITY + 1);
  });

  it('accepts a destination again once its queue has drained', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    const forwarder = new WebhookForwarder(noConfigs, 'https://hook.example.com', undefined);

    await forwarder.forward(envelope('m1'));
    await forwarder.drain();
    await forwarder.forward(envelope('m2'));
    await forwarder.drain();

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('sends what the event was when it was queued', async () => {
    const calls = manualFetch();
    const forwarder = new WebhookForwarder(noConfigs, 'https://hook.example.com', undefined);
    const message = envelope('m1');

    await forwarder.forward(envelope('first'));
    await forwarder.forward(message);
    message.content = { type: 'text', body: 'changed later' };
    calls[0]!.answer();
    await flush();
    calls[1]!.answer();
    await forwarder.drain();

    expect(JSON.parse(calls[1]!.body).content.body).toBe('m1');
  });

  it('a webhook that hangs does not delay storing messages: real pipeline, log and forwarder', async () => {
    const calls = manualFetch();
    const store = new SqliteMessageStore(':memory:');
    await store.init();
    await store.runMigrations();
    const forwarder = new WebhookForwarder(noConfigs, 'https://hung.example.com', undefined);
    const eventBus = new EventBus();
    eventBus.on<MessageInboundPayload>(Events.MESSAGE_INBOUND, (event) => forwarder.forward(event.data.envelope));
    const pipeline = new InboundPipeline({ store, eventBus, media: noopMediaService, metrics: noopMetrics, accounts: { findById: async () => undefined } });
    const account = { id: 'wa-1', provider: 'baileys' } as ChannelAccount;

    await pipeline.handle(account, envelope('m1'), {});
    await pipeline.handle(account, envelope('m2'), {});

    expect(await store.maxAccountSeq('wa-1')).toBe(2);
    expect(calls).toHaveLength(1); // m1 is stuck in flight, m2 waits in the queue

    calls[0]!.answer();
    await flush();
    calls[1]!.answer();
    await forwarder.drain();
    expect(calls.map((c) => JSON.parse(c.body).accountSeq)).toEqual([1, 2]);
    await store.close();
  });
});
