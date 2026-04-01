import type { ChannelAccount } from '../accounts/channel-account.js';
import type { UnifiedEnvelope } from './unified-envelope.js';

export interface RawRequest {
  headers: Record<string, string | undefined>;
  body: unknown;
  query: Record<string, string | undefined>;
}

export interface InboundWebhookPort<TRawPayload, TChannelEvent> {
  parseIncoming(raw: TRawPayload): TChannelEvent;
  validateSignature(req: RawRequest): boolean;
  toEnvelope(event: TChannelEvent, account: ChannelAccount): UnifiedEnvelope;
}
