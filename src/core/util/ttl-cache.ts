interface Entry<V> {
  value: V;
  expiresAt: number;
}

/**
 * Tiny in-memory cache with a per-entry time-to-live and a size cap.
 *
 * Expired entries are dropped lazily on read. When the cap is exceeded the
 * oldest entry (by insertion/last `set`) goes first; a re-set key counts as new.
 * The method names (`get`/`set`/`del`/`flushAll`) match what Baileys expects from
 * its `CacheStore`, so an instance can be handed to a socket directly.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, Entry<V>>();

  constructor(
    private readonly ttlMs: number,
    private readonly max: number = Number.POSITIVE_INFINITY,
  ) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V): void {
    // Delete first so a re-set key moves to the end of the insertion order.
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  del(key: string): void {
    this.entries.delete(key);
  }

  flushAll(): void {
    this.entries.clear();
  }
}
