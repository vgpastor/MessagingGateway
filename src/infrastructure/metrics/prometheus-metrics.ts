import { Counter, Gauge, Histogram, type Metric } from 'prom-client';
import type { InboundSkipReason, MediaSkipReason, MetricsPort } from '../../core/metrics/metrics.port.js';
import {
  registry,
  persistFailuresTotal,
  mediaSkippedTotal,
  inboundSkippedTotal,
  lastInboundTimestamp,
} from './prometheus.js';

/**
 * {@link MetricsPort} backed by the Prometheus registry. Generic calls are routed by
 * metric name; an unknown name is ignored so instrumentation can never break a code path.
 */
export class PrometheusMetrics implements MetricsPort {
  incCounter(name: string, labels: Record<string, string> = {}): void {
    const metric = this.find(name);
    if (metric instanceof Counter) metric.inc(labels);
  }

  incGauge(name: string, labels: Record<string, string> = {}): void {
    const metric = this.find(name);
    if (metric instanceof Gauge) metric.inc(labels);
  }

  decGauge(name: string, labels: Record<string, string> = {}): void {
    const metric = this.find(name);
    if (metric instanceof Gauge) metric.dec(labels);
  }

  observeHistogram(name: string, value: number, labels: Record<string, string> = {}): void {
    const metric = this.find(name);
    if (metric instanceof Histogram) metric.observe(labels, value);
  }

  persistFailures(): void {
    persistFailuresTotal.inc();
  }

  mediaSkipped(reason: MediaSkipReason): void {
    mediaSkippedTotal.inc({ reason });
  }

  inboundSkipped(reason: InboundSkipReason): void {
    inboundSkippedTotal.inc({ reason });
  }

  lastInbound(account: string, ts: number): void {
    lastInboundTimestamp.set({ account }, ts);
  }

  private find(name: string): Metric | undefined {
    return registry.getSingleMetric(name);
  }
}
