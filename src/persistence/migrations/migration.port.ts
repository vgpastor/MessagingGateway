/**
 * Database migration adapter — pure infrastructure contract.
 * No domain dependencies. Implementations wrap a specific DB driver.
 */
export interface MigrationAdapter {
  /** Create the migrations tracking table if it doesn't exist */
  ensureMigrationTable(): Promise<void>;

  /** Return names of already-applied migrations, in order */
  getAppliedMigrations(): Promise<string[]>;

  /** Execute a raw SQL string (may contain multiple statements) */
  executeSql(sql: string): Promise<void>;

  /** Record a migration as applied */
  recordMigration(name: string, checksum: string): Promise<void>;
}
