import type Database from 'better-sqlite3';
import type { MigrationAdapter } from '../migration.port.js';

/**
 * SQLite migration adapter — wraps a better-sqlite3 Database instance.
 * Zero domain dependencies.
 */
export class SqliteMigrationAdapter implements MigrationAdapter {
  constructor(private readonly db: Database.Database) {}

  async ensureMigrationTable(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
  }

  async getAppliedMigrations(): Promise<string[]> {
    const rows = this.db.prepare('SELECT name FROM _migrations ORDER BY name').all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  async executeSql(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async recordMigration(name: string, checksum: string): Promise<void> {
    this.db.prepare('INSERT INTO _migrations (name, checksum, applied_at) VALUES (?, ?, ?)').run(
      name,
      checksum,
      new Date().toISOString(),
    );
  }
}
