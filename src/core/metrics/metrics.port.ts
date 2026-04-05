/** Port for metrics instrumentation — keeps connections layer decoupled from metric implementation */

export interface MetricsPort {
  incCounter(name: string, labels?: Record<string, string>): void;
  decGauge(name: string, labels?: Record<string, string>): void;
  incGauge(name: string, labels?: Record<string, string>): void;
  observeHistogram(name: string, value: number, labels?: Record<string, string>): void;
}

/** No-op implementation for when metrics are disabled */
export const noopMetrics: MetricsPort = {
  incCounter: () => {},
  decGauge: () => {},
  incGauge: () => {},
  observeHistogram: () => {},
};
