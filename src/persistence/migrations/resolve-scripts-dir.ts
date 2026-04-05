import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Resolves the absolute path to migration SQL scripts for a given driver.
 *
 * Works both in development (src/) and production (dist/) by probing
 * common locations relative to the project root (process.cwd()).
 */
export function resolveMigrationScriptsDir(driver: 'sqlite' | 'postgres'): string {
  const cwd = process.cwd();

  // Production: dist/persistence/migrations/scripts/<driver>
  const distPath = resolve(cwd, 'dist', 'persistence', 'migrations', 'scripts', driver);
  if (existsSync(distPath)) {
    return distPath;
  }

  // Development: src/persistence/migrations/scripts/<driver>
  const srcPath = resolve(cwd, 'src', 'persistence', 'migrations', 'scripts', driver);
  if (existsSync(srcPath)) {
    return srcPath;
  }

  // Docker / custom layout: check relative to the main entry point
  const mainDir = dirname(require.main?.filename ?? '');
  if (mainDir) {
    const entryPath = resolve(mainDir, 'persistence', 'migrations', 'scripts', driver);
    if (existsSync(entryPath)) {
      return entryPath;
    }
  }

  // Last resort — return dist path and let the runner handle missing dir gracefully
  return distPath;
}
