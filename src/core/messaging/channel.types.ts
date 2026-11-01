export type ChannelType = 'whatsapp' | 'telegram' | 'email' | 'sms';

export type ProviderType =
  | 'wwebjs-api'
  | 'evolution-api'
  | 'meta-cloud-api'
  | 'baileys'
  | 'telegram-bot-api'
  | 'brevo'
  | 'ses'
  | 'twilio'
  | 'messagebird';

export type ContentType =
  | 'text'
  | 'image'
  | 'audio'
  | 'video'
  | 'document'
  | 'location'
  | 'contact'
  | 'sticker'
  | 'reaction'
  | 'status_update'
  | 'system'
  | 'unknown';

export interface ContactRef {
  id: string;
  displayName?: string;
  /** Phone number in E.164 format with leading `+` (e.g. `+34600111222`) when known. */
  phone?: string;
  /** WhatsApp LID JID (e.g. `144980999962625@lid`) when the channel exposes one. */
  lid?: string;
}
