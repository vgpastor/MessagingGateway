import { getLogger } from './logger/logger.port.js';

export interface DomainEvent<T = unknown> {
  id: string;
  type: string;
  timestamp: Date;
  source: string;
  accountId?: string;
  data: T;
}

type EventHandler<T = unknown> = (event: DomainEvent<T>) => Promise<void> | void;

export class EventBus {
  private handlers = new Map<string, Set<EventHandler>>();

  on<T>(type: string, handler: EventHandler<T>): void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as EventHandler);
  }

  off(type: string, handler: EventHandler): void {
    this.handlers.get(type)?.delete(handler);
  }

  async emit<T>(event: DomainEvent<T>): Promise<void> {
    const handlers = this.handlers.get(event.type);
    if (!handlers?.size) return;

    const results = [...handlers].map((handler) => {
      try {
        return Promise.resolve(handler(event as DomainEvent));
      } catch (err) {
        getLogger().error('Sync error in event handler', { module: 'event-bus', eventType: event.type, error: err instanceof Error ? err.message : String(err) });
        return Promise.resolve();
      }
    });

    await Promise.allSettled(results);
  }

  listenerCount(type: string): number {
    return this.handlers.get(type)?.size ?? 0;
  }
}
