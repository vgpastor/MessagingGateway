import type { UnifiedEnvelope } from '../../core/messaging/unified-envelope.js';

export interface EmailInboundEvent {
  messageId: string;
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  replyTo?: EmailAddress;
  subject: string;
  textBody?: string;
  htmlBody?: string;
  attachments: EmailAttachment[];
  headers: Record<string, string>;
  raw: unknown;
}

export interface EmailAddress {
  address: string;
  name?: string;
}

export interface EmailAttachment {
  fileName: string;
  mimeType: string;
  size: number;
  contentId?: string;
  url?: string;
}

export type EmailEnvelope = UnifiedEnvelope<EmailInboundEvent>;
