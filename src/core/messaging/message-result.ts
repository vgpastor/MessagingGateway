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
  /**
   * The sent message in the provider's own storable form, for the providers that may be asked to
   * send it again. Goes to the message log; the router keeps it from reaching callers.
   */
  providerRaw?: unknown;
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
