import { describe, it, expect, beforeEach } from 'vitest';
import { PrometheusMetrics } from '../../../src/infrastructure/metrics/prometheus-metrics.js';
import { registry } from '../../../src/infrastructure/metrics/prometheus.js';

async function sample(name: string, labels: Record<string, string> = {}): Promise<number | undefined> {
  const metric = (await registry.getMetricsAsJSON()).find((m) => m.name === name);
  const value = metric?.values.find((v) =>
    Object.entries(labels).every(([k, expected]) => (v.labels as Record<string, unknown>)[k] === expected),
  );
  return value?.value;
}

describe('PrometheusMetrics', () => {
  let metrics: PrometheusMetrics;

  beforeEach(() => {
    registry.resetMetrics();
    metrics = new PrometheusMetrics();
  });

  it('wsClientsConnected reflects connected clients', async () => {
    metrics.incGauge('umg_ws_clients_connected');
    metrics.incGauge('umg_ws_clients_connected');
    metrics.decGauge('umg_ws_clients_connected');

    expect(await sample('umg_ws_clients_connected')).toBe(1);
  });

  it('persistFailures increments counter', async () => {
    metrics.persistFailures();
    metrics.persistFailures();

    expect(await sample('umg_persist_failures_total')).toBe(2);
  });

  it('mediaSkipped counts per reason', async () => {
    metrics.mediaSkipped('too_large');
    metrics.mediaSkipped('too_large');
    metrics.mediaSkipped('download_failed');

    expect(await sample('umg_media_skipped_total', { reason: 'too_large' })).toBe(2);
    expect(await sample('umg_media_skipped_total', { reason: 'download_failed' })).toBe(1);
  });

  it('lastInbound sets the per-account timestamp in seconds since epoch', async () => {
    metrics.lastInbound('wa-acme', 1_700_000_000);

    expect(await sample('umg_last_inbound_timestamp', { account: 'wa-acme' })).toBe(1_700_000_000);
  });

  it('incCounter and observeHistogram drive the registered metrics by name', async () => {
    metrics.incCounter('umg_messages_total', { direction: 'inbound', channel: 'whatsapp', account: 'wa-acme', content_type: 'text' });
    metrics.observeHistogram('umg_webhook_forward_duration_seconds', 0.2, { account: 'wa-acme', url: 'https://x', status: '200' });

    expect(await sample('umg_messages_total', { account: 'wa-acme' })).toBe(1);
    const text = await registry.metrics();
    expect(text).toContain('umg_webhook_forward_duration_seconds_count{account="wa-acme",url="https://x",status="200"} 1');
  });

  it('ignores unknown metric names instead of throwing', () => {
    expect(() => metrics.incCounter('umg_nope')).not.toThrow();
    expect(() => metrics.incGauge('umg_nope')).not.toThrow();
    expect(() => metrics.decGauge('umg_nope')).not.toThrow();
    expect(() => metrics.observeHistogram('umg_nope', 1)).not.toThrow();
  });
});
