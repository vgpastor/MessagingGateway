export type MessageStatusType =
  | 'queued'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'played'
  | 'failed'
  | 'unknown';

export interface MessageResult {
  messageId: string;
  status: MessageStatusType;
  timestamp: Date;
  providerMessageId?: string;
  error?: string;
  /** Remote JID returned by the provider (e.g. Baileys). Used to align outbound conversationId with inbound. */
  remoteJid?: string;
}

export interface MessageStatus {
  messageId: string;
  status: MessageStatusType;
  timestamp: Date;
  providerMessageId?: string;
  failureReason?: string;
}

export interface MediaContent {
  data: Buffer;
  mimeType: string;
  fileName?: string;
  size: number;
}
