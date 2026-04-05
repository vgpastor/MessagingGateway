import { getLogger } from '../core/logger/logger.port.js';
import type { EventBus } from '../core/event-bus.js';
import { Events } from '../core/events.js';
import type { MessageInboundPayload, MessageOutboundPayload } from '../core/events.js';
import type { MessageStorePort } from './message-store.port.js';

/**
 * Subscribes to EventBus events and persists messages.
 * Stores both inbound and outbound messages for full conversation history.
 * Only active when STORAGE_ENABLED=true.
 */
export function subscribePersistence(eventBus: EventBus, store: MessageStorePort): void {
  const logger = getLogger().child({ module: 'persistence' });

  eventBus.on<MessageInboundPayload>(Events.MESSAGE_INBOUND, async (event) => {
    try {
      await store.save(event.data.envelope);
    } catch (err) {
      logger.error('Failed to persist inbound message', {
        messageId: event.data.envelope.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

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

  logger.info('Persistence subscriber active — storing inbound + outbound messages');
}
