export type ChannelType = 'whatsapp' | 'telegram' | 'email' | 'sms';

export type ProviderType =
  | 'wwebjs-api'
  | 'evolution-api'
  | 'meta-cloud-api'
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
}
