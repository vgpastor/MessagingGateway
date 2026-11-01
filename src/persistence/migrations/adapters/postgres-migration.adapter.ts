import type { MigrationAdapter, MigrationScript } from '../migration.port.js';

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

  /** Script and record in one explicit transaction on one dedicated connection. */
  async applyMigration({ name, checksum, sql }: MigrationScript): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations (name, checksum) VALUES ($1, $2)', [name, checksum]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}
