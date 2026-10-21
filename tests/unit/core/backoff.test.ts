import { describe, it, expect } from 'vitest';
import { computeBackoffMs } from '../../../src/core/util/backoff.js';

describe('computeBackoffMs', () => {
  it('grows exponentially and caps at 300000', () => {
    const max = () => 1;

    expect(computeBackoffMs(0, { random: max })).toBe(1000);
    expect(computeBackoffMs(1, { random: max })).toBe(2000);
    expect(computeBackoffMs(3, { random: max })).toBe(8000);
    expect(computeBackoffMs(20, { random: max })).toBe(300000);
  });

  it('applies full jitter: anywhere between 0 and the exponential ceiling', () => {
    expect(computeBackoffMs(3, { random: () => 0 })).toBe(0);
    expect(computeBackoffMs(3, { random: () => 0.5 })).toBe(4000);
  });

  it('honours custom base and cap', () => {
    expect(computeBackoffMs(2, { baseMs: 500, maxMs: 1500, random: () => 1 })).toBe(1500);
    expect(computeBackoffMs(1, { baseMs: 500, maxMs: 10_000, random: () => 1 })).toBe(1000);
  });

  it('never exceeds the cap with the default random source', () => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const delay = computeBackoffMs(attempt);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(300000);
    }
  });
});
