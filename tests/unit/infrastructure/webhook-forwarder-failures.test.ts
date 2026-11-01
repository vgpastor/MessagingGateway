import { describe, it, expect, vi, afterEach } from 'vitest';
import { WebhookForwarder, WEBHOOK_QUEUE_CAPACITY } from '../../../src/connections/webhooks/webhook-forwarder.js';
import { getLogger, setGlobalLogger, type Logger } from '../../../src/core/logger/logger.port.js';
import type { WebhookConfig } from '../../../src/core/webhooks/webhook-config.js';
import type { WebhookConfigRepository } from '../../../src/core/webhooks/webhook-config.repository.js';
import type { UnifiedEnvelope } from '../../../src/core/messaging/unified-envelope.js';
import { PrometheusMetrics } from '../../../src/infrastructure/metrics/prometheus-metrics.js';
import { registry } from '../../../src/infrastructure/metrics/prometheus.js';

const hook: WebhookConfig = {
  id: 'wh_t',
  accountId: 'wa-acme',
  url: 'https://hook.example.com',
  events: ['*'],
  enabled: true,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

function makeRepo(config: WebhookConfig): WebhookConfigRepository {
  return {
    findByAccountId: vi.fn().mockResolvedValue([config]),
    findById: vi.fn().mockResolvedValue(config),
    findAll: vi.fn().mockResolvedValue([config]),
    add: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    removeByAccountId: vi.fn(),
  };
}

function makeEnvelope(): UnifiedEnvelope {
  return {
    id: 'msg_123',
    accountId: 'wa-acme',
    channel: 'whatsapp',
    direction: 'inbound',
    timestamp: new Date(),
    conversationId: '34699000001@c.us',
    sender: { id: '34699000001@c.us' },
    recipient: { id: '+34600000001' },
    content: { type: 'text', body: 'Hello' },
    channelDetails: { platform: 'whatsapp', messageId: 'wamid.test123' },
    gateway: {
      receivedAt: new Date(),
      adapterId: 'wwebjs-api',
      account: { id: 'wa-acme', alias: 'Test', owner: 'test', tags: [] },
    },
  };
}

function metricsSpy() {
  return {
    incCounter: vi.fn(), decGauge: vi.fn(), incGauge: vi.fn(), observeHistogram: vi.fn(),
    persistFailures: vi.fn(), mediaSkipped: vi.fn(), inboundSkipped: vi.fn(), lastInbound: vi.fn(),
  };
}

describe('WebhookForwarder failure handling', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('gives up on a webhook that never answers after 10s and counts it as a failed forward', async () => {
    vi.useFakeTimers();
    // The runtime AbortSignal.timeout runs on a native timer that fake timers cannot advance: mirror it on setTimeout.
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('The operation timed out', 'TimeoutError')), ms);
      return controller.signal;
    });
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    })));
    const metrics = metricsSpy();
    const forwarder = new WebhookForwarder(makeRepo(hook), undefined, undefined, metrics);

    let settled = false;
    await forwarder.forward(makeEnvelope());
    const done = forwarder.drain().then(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await done;

    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
    expect(settled).toBe(true);
    expect(metrics.incCounter).toHaveBeenCalledWith('umg_webhook_failures_total', { account: 'wa-acme' });
    expect(metrics.observeHistogram).toHaveBeenCalledWith(
      'umg_webhook_forward_duration_seconds', expect.any(Number), expect.objectContaining({ status: 'error' }),
    );
  });

  it('counts a non-2xx answer as a failed forward', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 500 })));
    const metrics = metricsSpy();
    const forwarder = new WebhookForwarder(makeRepo(hook), undefined, undefined, metrics);

    await forwarder.forward(makeEnvelope());
    await forwarder.drain();

    expect(metrics.incCounter).toHaveBeenCalledWith('umg_webhook_failures_total', { account: 'wa-acme' });
  });

  it('counts a network error as a failed forward without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const metrics = metricsSpy();
    const forwarder = new WebhookForwarder(makeRepo(hook), undefined, undefined, metrics);

    await expect(forwarder.forward(makeEnvelope())).resolves.toBeUndefined();
    await forwarder.drain();

    expect(metrics.incCounter).toHaveBeenCalledWith('umg_webhook_failures_total', { account: 'wa-acme' });
  });

  it('does not count a successful forward as a failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok', { status: 200 })));
    const metrics = metricsSpy();
    const forwarder = new WebhookForwarder(makeRepo(hook), undefined, undefined, metrics);

    await forwarder.forward(makeEnvelope());
    await forwarder.drain();

    expect(metrics.incCounter).not.toHaveBeenCalled();
  });
});

describe('WebhookForwarder metrics exposure', () => {
  const secretHook: WebhookConfig = { ...hook, url: 'https://hook.example.com/in?token=SECRET' };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['a 2xx answer', () => Promise.resolve(new Response('ok', { status: 200 }))],
    ['a non-2xx answer', () => Promise.resolve(new Response('boom', { status: 500 }))],
    ['a network error', () => Promise.reject(new Error('ECONNREFUSED'))],
  ])('never puts the webhook URL (or its token) in /metrics after %s', async (_label, answer) => {
    registry.resetMetrics();
    vi.stubGlobal('fetch', vi.fn(answer));
    const forwarder = new WebhookForwarder(makeRepo(secretHook), undefined, undefined, new PrometheusMetrics());

    await forwarder.forward(makeEnvelope());
    await forwarder.drain();

    const text = await registry.metrics();
    expect(text).toContain('umg_webhook_forward_duration_seconds_count{account="wa-acme"');
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('hook.example.com');
    expect(text).not.toContain('url=');
  });
});

describe('WebhookForwarder logs', () => {
  const SECRET_URL = 'https://hooks.example.com/services/T000/B000/s3cr3t-token?key=abc';
  const original = getLogger();

  function capture() {
    const lines: string[] = [];
    const record = (msg: string, ctx?: Record<string, unknown>) => { lines.push(`${msg} ${JSON.stringify(ctx ?? {})}`); };
    const fake = { info: record, warn: record, error: record, debug: record, child: () => fake };
    setGlobalLogger(fake as unknown as Logger);
    return lines;
  }

  afterEach(() => {
    setGlobalLogger(original);
    vi.unstubAllGlobals();
  });

  async function deliver(url = SECRET_URL) {
    const forwarder = new WebhookForwarder(makeRepo({ ...hook, url }), undefined, undefined);
    await forwarder.forward(makeEnvelope());
    await forwarder.drain();
  }

  it('name only the host when the destination answers an error', async () => {
    const lines = capture();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('no', { status: 500 })));

    await deliver();

    expect(lines.join('\n')).toContain('hooks.example.com');
    expect(lines.join('\n')).not.toContain('s3cr3t-token');
    expect(lines.join('\n')).not.toContain('key=abc');
  });

  it('name only the host when the request fails, even if the error quotes the URL', async () => {
    const lines = capture();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError(`Failed to parse URL from ${SECRET_URL}`)));

    await deliver();

    expect(lines.join('\n')).toContain('hooks.example.com');
    expect(lines.join('\n')).not.toContain('s3cr3t-token');
  });

  it('name only the host when the queue drops an event', async () => {
    const lines = capture();
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {}))); // the first delivery never ends
    const forwarder = new WebhookForwarder(makeRepo({ ...hook, url: SECRET_URL }), undefined, undefined);

    for (let i = 0; i < WEBHOOK_QUEUE_CAPACITY + 2; i++) forwarder.send(SECRET_URL, undefined, 'wa-acme', {}, 'message.inbound');

    expect(lines.join('\n')).toContain('hooks.example.com');
    expect(lines.join('\n')).not.toContain('s3cr3t-token');
  });

  it('do not leak a URL that cannot be parsed', async () => {
    const lines = capture();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to parse URL from not a url/s3cr3t-token')));

    await deliver('not a url/s3cr3t-token');

    expect(lines.join('\n')).not.toContain('s3cr3t-token');
  });
});

describe('WebhookForwarder.sendConfirmed', () => {
  afterEach(() => vi.unstubAllGlobals());

  const confirmed = (forwarder: WebhookForwarder) => forwarder.sendConfirmed('https://alerts.test/hook', undefined, 'wa-acme', { a: 1 }, 'connection.update');
  const forwarder = () => new WebhookForwarder(makeRepo(hook), undefined, undefined);

  it('resolves true on a 2xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(confirmed(forwarder())).resolves.toBe(true);
  });

  it('resolves false on any other answer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('no', { status: 503 })));
    await expect(confirmed(forwarder())).resolves.toBe(false);
  });

  it('resolves false when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(confirmed(forwarder())).resolves.toBe(false);
  });

  it('resolves false when the queue drops it, instead of never', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {}))); // the first delivery never ends
    const sender = forwarder();
    sender.send('https://alerts.test/hook', undefined, 'wa-acme', {}, 'connection.update');

    const dropped = confirmed(sender);
    for (let i = 0; i < WEBHOOK_QUEUE_CAPACITY; i++) sender.send('https://alerts.test/hook', undefined, 'wa-acme', {}, 'connection.update');

    await expect(dropped).resolves.toBe(false);
  });
});

describe('WebhookForwarder event filters', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('apply to messages but not to connection.update, which reaches any hook subscribed to it or to *', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const filtered: WebhookConfig = { ...hook, events: ['*'], filters: { exclude: { channel: 'whatsapp' } } };
    const forwarder = new WebhookForwarder(makeRepo(filtered), undefined, undefined);

    await forwarder.forward(makeEnvelope());
    await forwarder.drain();
    expect(fetchSpy).not.toHaveBeenCalled();

    await forwarder.forwardRaw('wa-acme', { status: 'auth_expired' }, 'connection.update');
    await forwarder.drain();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
