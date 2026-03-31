export type AccountIdentity =
  | WhatsAppIdentity
  | TelegramIdentity
  | EmailIdentity
  | SmsIdentity;

export interface WhatsAppIdentity {
  channel: 'whatsapp';
  phoneNumber: string;
  wid?: string;
}

export interface TelegramIdentity {
  channel: 'telegram';
  botId?: string;
  botUsername: string;
}

export interface EmailIdentity {
  channel: 'email';
  address: string;
  domain?: string;
}

export interface SmsIdentity {
  channel: 'sms';
  phoneNumber: string;
  senderId?: string;
}
