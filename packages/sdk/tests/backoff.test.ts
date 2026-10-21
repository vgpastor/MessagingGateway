import { describe, it, expect } from 'vitest';
import { computeBackoffMs } from '../src/backoff.js';

describe('computeBackoffMs', () => {
  it('uses SDK defaults (base 1s, cap 60s) with full jitter', () => {
    expect(computeBackoffMs(0, { random: () => 1 })).toBe(1000);
    expect(computeBackoffMs(3, { random: () => 1 })).toBe(8000);
    expect(computeBackoffMs(10, { random: () => 1 })).toBe(60_000);
    expect(computeBackoffMs(2, { random: () => 0 })).toBe(0);
    expect(computeBackoffMs(2, { random: () => 0.5 })).toBe(2000);
  });

  it('honours custom base and cap', () => {
    expect(computeBackoffMs(5, { baseMs: 10, maxMs: 100, random: () => 1 })).toBe(100);
  });
});
