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

  // Docker / custom layout: check relative to this file's location
  // Works in both CJS and ESM — __dirname equivalent via resolve trick
  const thisDir = dirname(resolve(cwd, 'dist', 'persistence', 'migrations', 'resolve-scripts-dir.js'));
  const nearbyPath = resolve(thisDir, 'scripts', driver);
  if (nearbyPath !== distPath && existsSync(nearbyPath)) {
    return nearbyPath;
  }

  // Last resort — return dist path and let the runner handle missing dir gracefully
  return distPath;
}
