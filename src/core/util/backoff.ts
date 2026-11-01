export interface BackoffOptions {
  /** Delay ceiling for attempt 0, in ms. Doubles on every attempt. */
  baseMs?: number;
  /** Hard cap for the delay ceiling, in ms. */
  maxMs?: number;
  /** Uniform random source in [0, 1). Injectable for deterministic tests. */
  random?: () => number;
}

const DEFAULT_BASE_MS = 1000;
const DEFAULT_MAX_MS = 300_000;

/**
 * Exponential backoff with full jitter: a uniformly random delay between 0 and
 * `min(maxMs, baseMs * 2 ** attempt)`. Full jitter keeps many clients that lost
 * their connection together from reconnecting in lockstep.
 *
 * `attempt` is zero-based (0 = first retry).
 */
export function computeBackoffMs(attempt: number, opts: BackoffOptions = {}): number {
  const { baseMs = DEFAULT_BASE_MS, maxMs = DEFAULT_MAX_MS, random = Math.random } = opts;
  return random() * Math.min(maxMs, baseMs * 2 ** attempt);
}
