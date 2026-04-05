import type { AccountIdentity } from './account-identity.js';
import type { ChannelType } from '../messaging/channel.types.js';

/** Build a default (empty) identity for a given channel */
export function buildDefaultIdentity(channel: ChannelType): AccountIdentity {
  switch (channel) {
    case 'whatsapp': return { channel: 'whatsapp', phoneNumber: '' };
    case 'telegram': return { channel: 'telegram', botUsername: '' };
    case 'email': return { channel: 'email', address: '' };
    case 'sms': return { channel: 'sms', phoneNumber: '' };
  }
}
