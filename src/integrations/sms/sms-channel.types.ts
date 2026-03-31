import type { UnifiedEnvelope } from '../../domain/messaging/unified-envelope.js';

export interface SmsInboundEvent {
  messageId: string;
  from: string;
  to: string;
  body: string;
  numSegments?: number;
  provider: string;
  raw: unknown;
}

export interface SmsStatusEvent {
  messageId: string;
  status: 'queued' | 'sent' | 'delivered' | 'failed' | 'undelivered';
  timestamp: Date;
  errorCode?: string;
  errorMessage?: string;
}

export type SmsEnvelope = UnifiedEnvelope<SmsInboundEvent>;
