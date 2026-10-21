/**
 * Reconnect backoff. Mirrors the gateway server's formula (src/core/util/backoff.ts);
 * the SDK is published standalone, so it carries its own copy instead of importing it.
 */
export interface BackoffOptions {
  /** Delay ceiling for attempt 0, in ms. Doubles on every attempt. */
  baseMs?: number;
  /** Hard cap for the delay ceiling, in ms. */
  maxMs?: number;
  /** Uniform random source in [0, 1). Injectable for deterministic tests. */
  random?: () => number;
}

export const DEFAULT_BACKOFF_BASE_MS = 1000;
export const DEFAULT_BACKOFF_MAX_MS = 60_000;

/**
 * Exponential backoff with full jitter: a uniformly random delay between 0 and
 * `min(maxMs, baseMs * 2 ** attempt)`. Full jitter keeps many clients that lost
 * their connection together from reconnecting in lockstep.
 *
 * `attempt` is zero-based (0 = first retry).
 */
export function computeBackoffMs(attempt: number, opts: BackoffOptions = {}): number {
  const { baseMs = DEFAULT_BACKOFF_BASE_MS, maxMs = DEFAULT_BACKOFF_MAX_MS, random = Math.random } = opts;
  return random() * Math.min(maxMs, baseMs * 2 ** attempt);
}
