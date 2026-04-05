import type { FullMessageStorePort } from '../core/persistence/message-store.port.js';
import type { EnvConfig } from '../infrastructure/config/env.config.js';
import { resolve } from 'node:path';

/** Store with migration capability (internal detail, not part of the port) */
interface MigratableStore extends FullMessageStorePort {
  runMigrations(): Promise<void>;
}

/**
 * Creates the appropriate MessageStore based on configuration.
 *
 * Orchestrates the full lifecycle: create → init (connect) → migrate.
 * This keeps init() in each store focused on connection setup only.
 *
 * STORAGE_DRIVER=sqlite (default) → SQLite with better-sqlite3
 * STORAGE_DRIVER=postgres         → PostgreSQL with pg
 */
export async function createMessageStore(config: EnvConfig): Promise<FullMessageStorePort> {
  let store: MigratableStore;

  if (config.storageDriver === 'postgres') {
    if (!config.databaseUrl) {
      throw new Error(
        'STORAGE_DRIVER=postgres requires DATABASE_URL to be set. ' +
        'Example: DATABASE_URL=postgres://user:pass@localhost:5432/messaging',
      );
    }
    const { PostgresMessageStore } = await import('./postgres-message-store.js');
    store = new PostgresMessageStore(config.databaseUrl);
  } else {
    // Default: SQLite
    const { SqliteMessageStore } = await import('./sqlite-message-store.js');
    const dbPath = resolve(process.cwd(), config.databasePath);
    store = new SqliteMessageStore(dbPath);
  }

  // Lifecycle: connect → migrate
  await store.init();
  await store.runMigrations();

  return store;
}
