import { WAMessageStubType, extractMessageContent, type WAMessage } from '@whiskeysockets/baileys';
import type { InboundSkipReason } from '../../../core/metrics/metrics.port.js';

/**
 * Why a Baileys message must not reach the inbound pipeline, or undefined to process it.
 *
 * - `ciphertext_stub`: Baileys could not decrypt the message, upserts a placeholder
 *   (`messageStubType` CIPHERTEXT, no content) with the real `key.id` and asks the sender
 *   to retry. The real message arrives later with the same id; logging the stub would
 *   take that id and the real content would then be dropped as a duplicate.
 * - `empty`: there is no message content at all, so there is nothing to log or deliver.
 */
export function baileysInboundSkipReason(msg: WAMessage): InboundSkipReason | undefined {
  if (msg.messageStubType === WAMessageStubType.CIPHERTEXT) return 'ciphertext_stub';
  if (!extractMessageContent(msg.message)) return 'empty';
  return undefined;
}
