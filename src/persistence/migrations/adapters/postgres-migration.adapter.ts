import type { MigrationAdapter } from '../migration.port.js';

type PgPool = import('pg').Pool;

/**
 * PostgreSQL migration adapter — wraps a pg Pool instance.
 * Zero domain dependencies.
 */
export class PostgresMigrationAdapter implements MigrationAdapter {
  constructor(private readonly pool: PgPool) {}

  async ensureMigrationTable(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  async getAppliedMigrations(): Promise<string[]> {
    const res = await this.pool.query('SELECT name FROM _migrations ORDER BY name');
    return res.rows.map((r) => r.name);
  }

  async executeSql(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async recordMigration(name: string, checksum: string): Promise<void> {
    await this.pool.query(
      'INSERT INTO _migrations (name, checksum) VALUES ($1, $2)',
      [name, checksum],
    );
  }
}
