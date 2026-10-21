import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const messagesTotal = new Counter({
  name: 'umg_messages_total',
  help: 'Total messages processed',
  labelNames: ['direction', 'channel', 'account', 'content_type'] as const,
  registers: [registry],
});

export const webhookForwardDuration = new Histogram({
  name: 'umg_webhook_forward_duration_seconds',
  help: 'Webhook forward duration in seconds',
  labelNames: ['account', 'url', 'status'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const wsClientsConnected = new Gauge({
  name: 'umg_ws_clients_connected',
  help: 'Number of connected WebSocket clients',
  registers: [registry],
});

export const connectionStatus = new Gauge({
  name: 'umg_connection_status',
  help: 'Provider connection status (1=connected, 0=disconnected)',
  labelNames: ['account', 'provider'] as const,
  registers: [registry],
});

export const storageMessagesTotal = new Counter({
  name: 'umg_storage_messages_total',
  help: 'Total messages stored in persistence',
  labelNames: ['account', 'channel'] as const,
  registers: [registry],
});

export const webhookFailuresTotal = new Counter({
  name: 'umg_webhook_failures_total',
  help: 'Webhook forwards that failed (non-2xx answer, network error or timeout)',
  labelNames: ['account'] as const,
  registers: [registry],
});

export const persistFailuresTotal = new Counter({
  name: 'umg_persist_failures_total',
  help: 'Inbound messages that could not be written to the message log',
  registers: [registry],
});

export const mediaSkippedTotal = new Counter({
  name: 'umg_media_skipped_total',
  help: 'Inbound media that was not stored',
  labelNames: ['reason'] as const,
  registers: [registry],
});

export const lastInboundTimestamp = new Gauge({
  name: 'umg_last_inbound_timestamp',
  help: 'Unix time (seconds) of the last inbound message processed per account',
  labelNames: ['account'] as const,
  registers: [registry],
});

export { registry };
