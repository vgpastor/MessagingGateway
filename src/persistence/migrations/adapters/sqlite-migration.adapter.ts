import type Database from 'better-sqlite3';
import type { MigrationAdapter, MigrationScript } from '../migration.port.js';

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

  /** Script and record in one transaction (rolled back as a whole if either fails). */
  async applyMigration({ name, checksum, sql }: MigrationScript): Promise<void> {
    this.db.transaction(() => {
      this.db.exec(sql);
      this.db
        .prepare('INSERT INTO _migrations (name, checksum, applied_at) VALUES (?, ?, ?)')
        .run(name, checksum, new Date().toISOString());
    })();
  }
}
