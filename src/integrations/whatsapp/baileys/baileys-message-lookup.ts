import { BufferJSON, proto } from '@whiskeysockets/baileys';
import type { MessageLogPort } from '../../../core/persistence/message-store.port.js';

/** Finds a message a socket may have to re-send or retry-decrypt; `undefined` when unknown. */
export type BaileysMessageLookup = (accountId: string, waMessageId: string) => Promise<proto.IMessage | undefined>;

/**
 * Build the Baileys `getMessage` backing from the message log.
 *
 * The log keeps the raw `WebMessageInfo` as JSON (see `toStorableRaw`): buffers are
 * BufferJSON-encoded and longs are strings, so the inner `message` is revived and
 * rebuilt as a `proto.Message`. Never throws: Baileys treats a miss as "unknown
 * message", and an error inside its retry path would only make things worse.
 */
export function createBaileysMessageLookup(store: Pick<MessageLogPort, 'findByWaMessageId'>): BaileysMessageLookup {
  return async (accountId, waMessageId) => {
    try {
      const stored = await store.findByWaMessageId(accountId, waMessageId);
      const message = (stored?.raw as { message?: unknown } | undefined)?.message;
      if (!message || typeof message !== 'object') return undefined;
      const revived = JSON.parse(JSON.stringify(message), BufferJSON.reviver) as Record<string, unknown>;
      return proto.Message.fromObject(revived);
    } catch {
      return undefined;
    }
  };
}
