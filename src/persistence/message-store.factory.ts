import type { MessageStorePort } from './message-store.port.js';
import type { EnvConfig } from '../infrastructure/config/env.config.js';
import { resolve } from 'node:path';

/**
 * Creates the appropriate MessageStore based on configuration.
 *
 * STORAGE_DRIVER=sqlite (default) → SQLite with better-sqlite3
 * STORAGE_DRIVER=postgres         → PostgreSQL with pg
 */
export async function createMessageStore(config: EnvConfig): Promise<MessageStorePort> {
  if (config.storageDriver === 'postgres') {
    if (!config.databaseUrl) {
      throw new Error(
        'STORAGE_DRIVER=postgres requires DATABASE_URL to be set. ' +
        'Example: DATABASE_URL=postgres://user:pass@localhost:5432/messaging',
      );
    }
    const { PostgresMessageStore } = await import('./postgres-message-store.js');
    return new PostgresMessageStore(config.databaseUrl);
  }

  // Default: SQLite
  const { SqliteMessageStore } = await import('./sqlite-message-store.js');
  const dbPath = resolve(process.cwd(), config.databasePath);
  return new SqliteMessageStore(dbPath);
}
