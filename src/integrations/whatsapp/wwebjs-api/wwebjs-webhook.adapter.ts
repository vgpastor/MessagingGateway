import type { InboundWebhookPort, RawRequest } from '../../../core/messaging/inbound-webhook.port.js';
import type { ChannelAccount } from '../../../core/accounts/channel-account.js';
import type { UnifiedEnvelope } from '../../../core/messaging/unified-envelope.js';
import type { WhatsAppInboundEvent } from '../whatsapp-channel.types.js';
import type { WwebjsInboundPayload } from './wwebjs.types.js';
import {
  mapWwebjsToWhatsAppEvent,
  buildWhatsAppEnvelope,
} from './wwebjs.mapper.js';
import { InvalidPayloadError } from '../../../core/errors.js';

export class WwebjsWebhookAdapter
  implements InboundWebhookPort<WwebjsInboundPayload, WhatsAppInboundEvent>
{
  parseIncoming(raw: WwebjsInboundPayload): WhatsAppInboundEvent {
    if (!raw.data?.id?._serialized) {
      throw new InvalidPayloadError('Missing message ID in wwebjs payload');
    }
    return mapWwebjsToWhatsAppEvent(raw);
  }

  validateSignature(_req: RawRequest): boolean {
    // wwebjs-api doesn't have built-in signature validation
    // Validation is handled at the network level (Docker network isolation)
    return true;
  }

  toEnvelope(
    event: WhatsAppInboundEvent,
    account: ChannelAccount,
  ): UnifiedEnvelope<WhatsAppInboundEvent> {
    return buildWhatsAppEnvelope(event, account);
  }
}
