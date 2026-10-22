import { getLogger } from '../core/logger/logger.port.js';
import type { EventBus } from '../core/event-bus.js';
import { Events } from '../core/events.js';
import type { MessageOutboundPayload } from '../core/events.js';
import type { MessageStorePort } from '../core/persistence/message-store.port.js';

/**
 * Subscribes to EventBus events and persists outbound messages.
 * Inbound messages are not handled here: the InboundPipeline writes them to the
 * message log before emitting, so a subscriber would only store them twice.
 * Only active when STORAGE_ENABLED=true.
 */
export function subscribePersistence(eventBus: EventBus, store: MessageStorePort): void {
  const logger = getLogger().child({ module: 'persistence' });

  eventBus.on<MessageOutboundPayload>(Events.MESSAGE_OUTBOUND, async (event) => {
    try {
      await store.save(event.data.envelope);
    } catch (err) {
      logger.error('Failed to persist outbound message', {
        messageId: event.data.envelope.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  logger.info('Persistence subscriber active — storing outbound messages');
}
