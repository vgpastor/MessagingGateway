import type { InboundWebhookPort, RawRequest } from '../../../core/messaging/inbound-webhook.port.js';
import type { ChannelAccount } from '../../../core/accounts/channel-account.js';
import type { UnifiedEnvelope } from '../../../core/messaging/unified-envelope.js';
import type { WhatsAppInboundEvent } from '../whatsapp-channel.types.js';
import type { proto } from '@whiskeysockets/baileys';
import { mapBaileysToWhatsAppEvent } from './baileys.mapper.js';
import { buildWhatsAppEnvelope } from '../whatsapp-content.mapper.js';
import { InvalidPayloadError } from '../../../core/errors.js';

export interface BaileysInboundPayload {
  messages: proto.IWebMessageInfo[];
  type: string;
}

export class BaileysWebhookAdapter
  implements InboundWebhookPort<BaileysInboundPayload, WhatsAppInboundEvent>
{
  parseIncoming(raw: BaileysInboundPayload): WhatsAppInboundEvent {
    const msg = raw.messages[0];
    if (!msg?.key?.id) {
      throw new InvalidPayloadError('Missing message ID in Baileys payload');
    }
    return mapBaileysToWhatsAppEvent(msg);
  }

  validateSignature(_req: RawRequest): boolean {
    return true;
  }

  toEnvelope(event: WhatsAppInboundEvent, account: ChannelAccount): UnifiedEnvelope {
    return buildWhatsAppEnvelope(event, account);
  }
}
