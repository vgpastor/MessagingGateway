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
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler as EventHandler);
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
        console.error(`[event-bus] Sync error in handler for '${event.type}':`, err);
        return Promise.resolve();
      }
    });

    await Promise.allSettled(results);
  }

  listenerCount(type: string): number {
    return this.handlers.get(type)?.size ?? 0;
  }
}
