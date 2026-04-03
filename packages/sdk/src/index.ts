// ── Auto-generated REST client and types (from OpenAPI via Orval) ──
export * from './generated/api.js';

// ── Configuration (must call before using generated client) ──
export { configure } from './fetch-mutator.js';

// ── WebSocket client (manual — not covered by OpenAPI) ──
export { MessagingGatewayEvents } from './events.js';

// ── Legacy REST client (prefer generated functions above) ──
export { MessagingGatewayClient, GatewayApiError } from './client.js';

// ── Manual types (WebSocket events + filters, not in OpenAPI) ──
export type {
  ClientConfig,
  EventsConfig,
  WsEventType,
  WsEvent,
  ConnectionUpdateData,
  MessageSentData,
  MessageSendFailedData,
  EnvelopeFilter,
  FilterValue,
} from './types.js';
