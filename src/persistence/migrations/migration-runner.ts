import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { MigrationAdapter } from './migration.port.js';

interface MigrationLogger {
  info(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

export interface MigrationRunnerOptions {
  /** Absolute path to the directory containing .sql files for the active driver */
  scriptsDir: string;
  /** The adapter that knows how to talk to the specific database */
  adapter: MigrationAdapter;
  /** Optional logger (defaults to console) */
  logger?: MigrationLogger;
}

/**
 * Generic migration runner — no DB-specific code, no domain knowledge.
 *
 * Reads numbered .sql files from `scriptsDir`, compares with what's already
 * applied (via the adapter), and runs pending ones in alphabetical order.
 */
export class MigrationRunner {
  private readonly scriptsDir: string;
  private readonly adapter: MigrationAdapter;
  private readonly logger: MigrationLogger;

  constructor(opts: MigrationRunnerOptions) {
    this.scriptsDir = opts.scriptsDir;
    this.adapter = opts.adapter;
    this.logger = opts.logger ?? { info: console.log, error: console.error };
  }

  async run(): Promise<{ applied: string[]; skipped: string[] }> {
    await this.adapter.ensureMigrationTable();

    const applied = new Set(await this.adapter.getAppliedMigrations());
    const available = await this.loadScripts();

    const pending = available.filter((s) => !applied.has(s.name));
    const skipped = available.filter((s) => applied.has(s.name)).map((s) => s.name);

    if (pending.length === 0) {
      this.logger.info('Migrations up to date', { applied: applied.size });
      return { applied: [], skipped };
    }

    const appliedNow: string[] = [];

    for (const script of pending) {
      try {
        await this.adapter.executeSql(script.sql);
        await this.adapter.recordMigration(script.name, script.checksum);
        appliedNow.push(script.name);
        this.logger.info('Migration applied', { name: script.name });
      } catch (err) {
        this.logger.error('Migration failed', {
          name: script.name,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    }

    return { applied: appliedNow, skipped };
  }

  private async loadScripts(): Promise<Array<{ name: string; sql: string; checksum: string }>> {
    let files: string[];
    try {
      files = await readdir(this.scriptsDir);
    } catch {
      return [];
    }

    const sqlFiles = files.filter((f) => f.endsWith('.sql')).sort();

    const scripts: Array<{ name: string; sql: string; checksum: string }> = [];
    for (const file of sqlFiles) {
      const sql = await readFile(join(this.scriptsDir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex').substring(0, 16);
      scripts.push({ name: file.replace('.sql', ''), sql, checksum });
    }

    return scripts;
  }
}
