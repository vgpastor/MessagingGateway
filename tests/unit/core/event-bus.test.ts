import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../../../src/core/event-bus.js';
import { createEvent } from '../../../src/core/events.js';

describe('EventBus', () => {
  it('should call registered handler on emit', async () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on('test.event', handler);

    const event = createEvent('test.event', 'test', { foo: 'bar' });
    await bus.emit(event);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(event);
  });

  it('should call multiple handlers for same event', async () => {
    const bus = new EventBus();
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.on('test.event', h1);
    bus.on('test.event', h2);

    await bus.emit(createEvent('test.event', 'test', {}));

    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  it('should not call handlers for different event type', async () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on('event.a', handler);

    await bus.emit(createEvent('event.b', 'test', {}));

    expect(handler).not.toHaveBeenCalled();
  });

  it('should remove handler with off()', async () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on('test.event', handler);
    bus.off('test.event', handler);

    await bus.emit(createEvent('test.event', 'test', {}));

    expect(handler).not.toHaveBeenCalled();
  });

  it('should isolate errors in handlers (Promise.allSettled)', async () => {
    const bus = new EventBus();
    const badHandler = vi.fn().mockRejectedValue(new Error('handler failed'));
    const goodHandler = vi.fn();
    bus.on('test.event', badHandler);
    bus.on('test.event', goodHandler);

    // Should not throw
    await bus.emit(createEvent('test.event', 'test', {}));

    expect(badHandler).toHaveBeenCalledOnce();
    expect(goodHandler).toHaveBeenCalledOnce();
  });

  it('should handle sync errors in handlers', async () => {
    const bus = new EventBus();
    const badHandler = vi.fn(() => { throw new Error('sync fail'); });
    const goodHandler = vi.fn();
    bus.on('test.event', badHandler);
    bus.on('test.event', goodHandler);

    await bus.emit(createEvent('test.event', 'test', {}));

    expect(goodHandler).toHaveBeenCalledOnce();
  });

  it('should report correct listenerCount', () => {
    const bus = new EventBus();
    expect(bus.listenerCount('test.event')).toBe(0);

    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.on('test.event', h1);
    bus.on('test.event', h2);
    expect(bus.listenerCount('test.event')).toBe(2);

    bus.off('test.event', h1);
    expect(bus.listenerCount('test.event')).toBe(1);
  });

  it('should handle emit with no listeners gracefully', async () => {
    const bus = new EventBus();
    await bus.emit(createEvent('unregistered.event', 'test', {}));
    // No error thrown
  });

  it('should support async handlers', async () => {
    const bus = new EventBus();
    const results: string[] = [];
    bus.on('test.event', async () => {
      await new Promise((r) => setTimeout(r, 10));
      results.push('async-done');
    });

    await bus.emit(createEvent('test.event', 'test', {}));
    expect(results).toEqual(['async-done']);
  });
});
