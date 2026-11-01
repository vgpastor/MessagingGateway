/** One migration script, as read from disk */
export interface MigrationScript {
  name: string;
  checksum: string;
  sql: string;
}

/**
 * Database migration adapter — pure infrastructure contract.
 * No domain dependencies. Implementations wrap a specific DB driver.
 */
export interface MigrationAdapter {
  /** Create the migrations tracking table if it doesn't exist */
  ensureMigrationTable(): Promise<void>;

  /** Return names of already-applied migrations, in order */
  getAppliedMigrations(): Promise<string[]>;

  /**
   * Run the script (may contain multiple statements) AND record it as applied, atomically:
   * both happen or neither does. A crash between the two would otherwise re-run a
   * non-idempotent script on every boot.
   */
  applyMigration(script: MigrationScript): Promise<void>;
}
