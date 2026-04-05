import { randomUUID } from 'node:crypto';
import type { DomainEvent } from './event-bus.js';
import type { UnifiedEnvelope } from './messaging/unified-envelope.js';
import type { SendMessageCommand } from './messaging/outbound-message.js';
import type { MessageResult } from './messaging/message-result.js';

// ── Event type constants ────────────────────────────────────────

export const Events = {
  // Inbound (Integration → Core → Connections)
  MESSAGE_INBOUND: 'message.inbound',
  MESSAGE_STATUS: 'message.status', // TODO: wire these events
  CONNECTION_UPDATE: 'connection.update',

  // Outbound (Connections → Core → Integration)
  MESSAGE_OUTBOUND: 'message.outbound',
  MESSAGE_SEND_REQUEST: 'message.send.request',
  MESSAGE_SEND_SUCCESS: 'message.send.success',
  MESSAGE_SEND_FAILURE: 'message.send.failure',

  // Account lifecycle
  ACCOUNT_HEALTH_CHANGED: 'account.health.changed', // TODO: wire these events
} as const;

// ── Event payloads ──────────────────────────────────────────────

export interface MessageInboundPayload {
  envelope: UnifiedEnvelope;
}

export interface MessageOutboundPayload {
  envelope: UnifiedEnvelope;
}

export interface ConnectionUpdatePayload {
  accountId: string;
  status: 'disconnected' | 'connecting' | 'connected';
  qr?: string;
}

export interface MessageSendRequestPayload {
  command: SendMessageCommand;
  replyTo?: string; // correlation ID for WS responses
}

export interface MessageSendSuccessPayload {
  result: MessageResult;
  accountId: string;
  replyTo?: string;
}

export interface MessageSendFailurePayload {
  error: string;
  code: string;
  accountId?: string;
  replyTo?: string;
}

// ── Factory helpers ─────────────────────────────────────────────

export function createEvent<T>(
  type: string,
  source: string,
  data: T,
  accountId?: string,
): DomainEvent<T> {
  return {
    id: randomUUID(),
    type,
    timestamp: new Date(),
    source,
    accountId,
    data,
  };
}
