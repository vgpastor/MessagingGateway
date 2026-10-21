import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TtlCache } from '../../../src/core/util/ttl-cache.js';

describe('TtlCache', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns what was stored and undefined for unknown keys', () => {
    const cache = new TtlCache<number>(1000);
    cache.set('a', 1);

    expect(cache.get('a')).toBe(1);
    expect(cache.get('missing')).toBeUndefined();
  });

  it('expires entries after ttl', () => {
    const cache = new TtlCache<string>(1000);
    cache.set('a', 'x');

    vi.advanceTimersByTime(999);
    expect(cache.get('a')).toBe('x');

    vi.advanceTimersByTime(2);
    expect(cache.get('a')).toBeUndefined();
  });

  it('restarts the ttl when a key is set again', () => {
    const cache = new TtlCache<string>(1000);
    cache.set('a', 'x');
    vi.advanceTimersByTime(800);
    cache.set('a', 'y');
    vi.advanceTimersByTime(800);

    expect(cache.get('a')).toBe('y');
  });

  it('evicts oldest beyond max', () => {
    const cache = new TtlCache<number>(60_000, 2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
  });

  it('treats a re-set key as the newest when evicting', () => {
    const cache = new TtlCache<number>(60_000, 2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 10);
    cache.set('c', 3);

    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(10);
  });

  it('del removes one key and flushAll removes everything', () => {
    const cache = new TtlCache<number>(1000);
    cache.set('a', 1);
    cache.set('b', 2);

    cache.del('a');
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);

    cache.flushAll();
    expect(cache.get('b')).toBeUndefined();
  });
});
