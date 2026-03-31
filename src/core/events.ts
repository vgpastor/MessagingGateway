import { randomUUID } from 'node:crypto';
import type { DomainEvent } from './event-bus.js';
import type { UnifiedEnvelope } from './messaging/unified-envelope.js';
import type { SendMessageCommand } from './messaging/outbound-message.js';
import type { MessageResult } from './messaging/message-result.js';

// ── Event type constants ────────────────────────────────────────

export const Events = {
  // Inbound (Integration → Core → Connections)
  MESSAGE_INBOUND: 'message.inbound',
  MESSAGE_STATUS: 'message.status',
  CONNECTION_UPDATE: 'connection.update',

  // Outbound (Connections → Core → Integration)
  MESSAGE_SEND_REQUEST: 'message.send.request',
  MESSAGE_SEND_SUCCESS: 'message.send.success',
  MESSAGE_SEND_FAILURE: 'message.send.failure',

  // Account lifecycle
  ACCOUNT_HEALTH_CHANGED: 'account.health.changed',
} as const;

// ── Event payloads ──────────────────────────────────────────────

export interface MessageInboundPayload {
  envelope: UnifiedEnvelope;
}

export interface MessageStatusPayload {
  messageId: string;
  accountId: string;
  status: string;
  timestamp: Date;
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

export interface AccountHealthChangedPayload {
  accountId: string;
  oldStatus: string;
  newStatus: string;
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
