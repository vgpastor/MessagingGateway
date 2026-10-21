import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MigrationRunner } from '../../../src/persistence/migrations/migration-runner.js';
import type { MigrationAdapter } from '../../../src/persistence/migrations/migration.port.js';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('MigrationRunner', () => {
  let adapter: MigrationAdapter;
  let tmpDir: string;
  const silentLogger = { info: vi.fn(), error: vi.fn() };

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `mg-migration-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });

    adapter = {
      ensureMigrationTable: vi.fn(),
      getAppliedMigrations: vi.fn().mockResolvedValue([]),
      applyMigration: vi.fn(),
    };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('should apply pending migrations in order', async () => {
    await writeFile(join(tmpDir, '001_first.sql'), 'CREATE TABLE t1 (id INT);');
    await writeFile(join(tmpDir, '002_second.sql'), 'CREATE TABLE t2 (id INT);');

    const runner = new MigrationRunner({ scriptsDir: tmpDir, adapter, logger: silentLogger });
    const result = await runner.run();

    expect(result.applied).toEqual(['001_first', '002_second']);
    expect(result.skipped).toEqual([]);
    expect(adapter.applyMigration).toHaveBeenCalledTimes(2);
    expect(vi.mocked(adapter.applyMigration).mock.calls.map(([m]) => [m.name, m.sql])).toEqual([
      ['001_first', 'CREATE TABLE t1 (id INT);'],
      ['002_second', 'CREATE TABLE t2 (id INT);'],
    ]);
  });

  it('should skip already-applied migrations', async () => {
    await writeFile(join(tmpDir, '001_first.sql'), 'CREATE TABLE t1 (id INT);');
    await writeFile(join(tmpDir, '002_second.sql'), 'CREATE TABLE t2 (id INT);');

    vi.mocked(adapter.getAppliedMigrations).mockResolvedValue(['001_first']);

    const runner = new MigrationRunner({ scriptsDir: tmpDir, adapter, logger: silentLogger });
    const result = await runner.run();

    expect(result.applied).toEqual(['002_second']);
    expect(result.skipped).toEqual(['001_first']);
    expect(adapter.applyMigration).toHaveBeenCalledTimes(1);
  });

  it('should do nothing when all migrations are applied', async () => {
    await writeFile(join(tmpDir, '001_first.sql'), 'CREATE TABLE t1 (id INT);');

    vi.mocked(adapter.getAppliedMigrations).mockResolvedValue(['001_first']);

    const runner = new MigrationRunner({ scriptsDir: tmpDir, adapter, logger: silentLogger });
    const result = await runner.run();

    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(['001_first']);
    expect(adapter.applyMigration).not.toHaveBeenCalled();
  });

  it('should handle empty scripts directory', async () => {
    const runner = new MigrationRunner({ scriptsDir: tmpDir, adapter, logger: silentLogger });
    const result = await runner.run();

    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('should handle non-existent scripts directory', async () => {
    const runner = new MigrationRunner({ scriptsDir: join(tmpDir, 'nonexistent'), adapter, logger: silentLogger });
    const result = await runner.run();

    expect(result.applied).toEqual([]);
  });

  it('should propagate SQL execution errors', async () => {
    await writeFile(join(tmpDir, '001_bad.sql'), 'INVALID SQL;');

    await writeFile(join(tmpDir, '002_next.sql'), 'CREATE TABLE t2 (id INT);');
    vi.mocked(adapter.applyMigration).mockRejectedValue(new Error('syntax error'));

    const runner = new MigrationRunner({ scriptsDir: tmpDir, adapter, logger: silentLogger });

    await expect(runner.run()).rejects.toThrow('syntax error');
    // stops at the first failure: later migrations are not attempted
    expect(adapter.applyMigration).toHaveBeenCalledTimes(1);
  });

  it('should ignore non-sql files', async () => {
    await writeFile(join(tmpDir, '001_real.sql'), 'CREATE TABLE t1 (id INT);');
    await writeFile(join(tmpDir, 'README.md'), 'Not a migration');
    await writeFile(join(tmpDir, '002_real.sql.bak'), 'Not a migration');

    const runner = new MigrationRunner({ scriptsDir: tmpDir, adapter, logger: silentLogger });
    const result = await runner.run();

    expect(result.applied).toEqual(['001_real']);
    expect(adapter.applyMigration).toHaveBeenCalledTimes(1);
  });

  it('should include checksum when recording migration', async () => {
    await writeFile(join(tmpDir, '001_first.sql'), 'CREATE TABLE t1 (id INT);');

    const runner = new MigrationRunner({ scriptsDir: tmpDir, adapter, logger: silentLogger });
    await runner.run();

    expect(adapter.applyMigration).toHaveBeenCalledWith(expect.objectContaining({ name: '001_first', checksum: expect.any(String) }));
    const checksum = vi.mocked(adapter.applyMigration).mock.calls[0]![0].checksum;
    expect(checksum).toHaveLength(16);
  });
});

