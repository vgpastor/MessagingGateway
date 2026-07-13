export type ChannelType = 'whatsapp' | 'telegram' | 'email' | 'sms' | 'mattermost';

export type ProviderType =
  | 'wwebjs-api'
  | 'evolution-api'
  | 'meta-cloud-api'
  | 'baileys'
  | 'telegram-bot-api'
  | 'brevo'
  | 'ses'
  | 'twilio'
  | 'messagebird'
  | 'mattermost';

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
