/**
 * A migration and its `_migrations` record are applied atomically: if either the
 * script or the record fails, nothing is applied and the next boot applies it cleanly.
 * Without this, a crash between "script ran" and "recorded" would re-run a
 * non-idempotent script (002/003) on every boot and never come up again.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MigrationRunner } from '../../../src/persistence/migrations/migration-runner.js';
import { PostgresMigrationAdapter } from '../../../src/persistence/migrations/adapters/postgres-migration.adapter.js';
import { SqliteMigrationAdapter } from '../../../src/persistence/migrations/adapters/sqlite-migration.adapter.js';

const silent = { info: () => {}, error: () => {} };

describe('migration atomicity (sqlite)', () => {
  let dir: string;
  let db: import('better-sqlite3').Database;
  const runner = () => new MigrationRunner({ scriptsDir: dir, adapter: new SqliteMigrationAdapter(db), logger: silent });
  const tables = () => (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 't_%' ORDER BY name`).all() as Array<{ name: string }>).map((r) => r.name);
  const recorded = () => (db.prepare('SELECT name FROM _migrations ORDER BY name').all() as Array<{ name: string }>).map((r) => r.name);

  beforeEach(async () => {
    const Database = (await import('better-sqlite3')).default;
    db = new Database(':memory:');
    dir = await mkdtemp(join(tmpdir(), 'mg-atomic-sqlite-'));
  });
  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('a script that fails halfway leaves nothing applied and nothing recorded', async () => {
    await writeFile(join(dir, '001_half.sql'), 'CREATE TABLE t_one (id INTEGER);\nINSERT INTO missing_table VALUES (1);');

    await expect(runner().run()).rejects.toThrow();
    expect(tables()).toEqual([]);
    expect(recorded()).toEqual([]);

    await writeFile(join(dir, '001_half.sql'), 'CREATE TABLE t_one (id INTEGER);');
    expect((await runner().run()).applied).toEqual(['001_half']);
    expect(tables()).toEqual(['t_one']);
  });

  it('a failing record rolls the script back, and the next run applies it cleanly', async () => {
    await writeFile(join(dir, '001_create.sql'), 'CREATE TABLE t_one (id INTEGER);\nINSERT INTO t_one VALUES (1);');
    await new SqliteMigrationAdapter(db).ensureMigrationTable();
    db.exec(`CREATE TRIGGER fail_record BEFORE INSERT ON _migrations BEGIN SELECT RAISE(ABORT, 'record failed'); END;`);

    await expect(runner().run()).rejects.toThrow('record failed');
    expect(tables()).toEqual([]);
    expect(recorded()).toEqual([]);

    db.exec('DROP TRIGGER fail_record');
    expect((await runner().run()).applied).toEqual(['001_create']);
    expect(tables()).toEqual(['t_one']);
    expect(db.prepare('SELECT COUNT(*) AS c FROM t_one').get()).toEqual({ c: 1 });
    expect(recorded()).toEqual(['001_create']);
  });
});

const PG_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!PG_URL)('migration atomicity (postgres)', () => {
  let dir: string;
  let schema: string;
  let pool: import('pg').Pool;
  const runner = () => new MigrationRunner({ scriptsDir: dir, adapter: new PostgresMigrationAdapter(pool), logger: silent });
  const tables = async () => (await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name LIKE 't\_%' ORDER BY table_name`, [schema])).rows.map((r) => r.table_name);
  const recorded = async () => (await pool.query('SELECT name FROM _migrations ORDER BY name')).rows.map((r) => r.name);

  beforeEach(async () => {
    const { Pool } = await import('pg');
    schema = `mgatomic_${randomUUID().replace(/-/g, '')}`;
    const root = new Pool({ connectionString: PG_URL });
    await root.query(`CREATE SCHEMA "${schema}"`);
    await root.end();
    const url = new URL(PG_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    pool = new Pool({ connectionString: url.toString() });
    dir = await mkdtemp(join(tmpdir(), 'mg-atomic-pg-'));
  });
  afterEach(async () => {
    await pool.end();
    const { Pool } = await import('pg');
    const cleanup = new Pool({ connectionString: PG_URL });
    await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await cleanup.end();
    await rm(dir, { recursive: true, force: true });
  });

  it('a script that fails halfway leaves nothing applied and nothing recorded', async () => {
    await writeFile(join(dir, '001_half.sql'), 'CREATE TABLE t_one (id INT);\nINSERT INTO missing_table VALUES (1);');

    await expect(runner().run()).rejects.toThrow();
    expect(await tables()).toEqual([]);
    expect(await recorded()).toEqual([]);
  });

  it('a failing record rolls the script back, and the next run applies it cleanly', async () => {
    await writeFile(join(dir, '001_create.sql'), 'CREATE TABLE t_one (id INT);\nINSERT INTO t_one VALUES (1);');
    await new PostgresMigrationAdapter(pool).ensureMigrationTable();
    await pool.query(`
      CREATE FUNCTION fail_record() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'record failed'; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_record BEFORE INSERT ON _migrations FOR EACH ROW EXECUTE FUNCTION fail_record();
    `);

    await expect(runner().run()).rejects.toThrow('record failed');
    expect(await tables()).toEqual([]);
    expect(await recorded()).toEqual([]);

    await pool.query('DROP TRIGGER fail_record ON _migrations');
    expect((await runner().run()).applied).toEqual(['001_create']);
    expect(await tables()).toEqual(['t_one']);
    expect((await pool.query('SELECT COUNT(*)::int AS c FROM t_one')).rows).toEqual([{ c: 1 }]);
    expect(await recorded()).toEqual(['001_create']);
  });

  it('returns the connection to the pool after a failure (no leaked transaction)', async () => {
    await writeFile(join(dir, '001_bad.sql'), 'SELECT * FROM missing_table;');
    for (let i = 0; i < 3; i++) await expect(runner().run()).rejects.toThrow();
    expect(pool.totalCount - pool.idleCount).toBe(0);
    expect((await pool.query('SELECT 1 AS ok')).rows).toEqual([{ ok: 1 }]);
  });
});
