import type { OutboundMessage } from './outbound-message.js';
import type { MediaContent, MessageResult, MessageStatus } from './message-result.js';

export interface MessagingPort {
  sendMessage(msg: OutboundMessage): Promise<MessageResult>;
  getMessageStatus(messageId: string): Promise<MessageStatus>;
  downloadMedia(mediaId: string): Promise<MediaContent>;
  markAsRead(messageId: string): Promise<void>;
}
