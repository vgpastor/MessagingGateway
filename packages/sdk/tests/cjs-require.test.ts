import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));

/**
 * What a consumer gets: the tarball `npm pack` makes (running `prepack`, as a publish does),
 * unpacked into the node_modules of a project outside this repository.
 */
let consumerDir: string;
let installedDir: string;

beforeAll(() => {
  consumerDir = mkdtempSync(join(tmpdir(), 'sdk-consumer-'));
  installedDir = join(consumerDir, 'node_modules', '@messaging-gateway', 'sdk');
  mkdirSync(installedDir, { recursive: true });

  execSync('npm pack', { cwd: pkgDir, stdio: 'pipe', env: { ...process.env, npm_config_pack_destination: consumerDir } });
  const tarball = readdirSync(consumerDir).find((f) => f.endsWith('.tgz'));
  // Relative paths: some tar builds read a Windows drive letter as a remote host.
  execFileSync('tar', ['-xzf', tarball!, '--strip-components=1', '-C', join('node_modules', '@messaging-gateway', 'sdk')], { cwd: consumerDir, stdio: 'pipe' });

  // Its one dependency, as an install would leave it.
  const ws = dirname(createRequire(import.meta.url).resolve('ws/package.json'));
  symlinkSync(ws, join(consumerDir, 'node_modules', 'ws'), 'junction');
}, 120_000);

afterAll(() => {
  rmSync(consumerDir, { recursive: true, force: true });
});

function runInConsumer(file: string, code: string): string {
  writeFileSync(join(consumerDir, file), code);
  return execFileSync(process.execPath, [file], { cwd: consumerDir, encoding: 'utf8' });
}

describe('the package as published', () => {
  it('ships the build, its types and nothing of the sources', () => {
    expect(existsSync(join(installedDir, 'dist', 'index.js'))).toBe(true);
    expect(existsSync(join(installedDir, 'dist', 'index.d.ts'))).toBe(true);
    expect(existsSync(join(installedDir, 'src'))).toBe(false);
    expect(existsSync(join(installedDir, 'tests'))).toBe(false);
  });

  it('exposes a "default" export condition after "import", with "types" first', () => {
    const pkg = JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8'));
    const root = pkg.exports['.'];
    expect(Object.keys(root)).toEqual(['types', 'import', 'default']);
    expect(root.default).toBe('./dist/index.js');
  });

  it('loads with require() from a CommonJS project (require(esm), Node >= 22.12)', () => {
    const output = runInConsumer('consumer.cjs', `
      const sdk = require('@messaging-gateway/sdk');
      console.log(typeof sdk.MessagingGatewayEvents, typeof sdk.MessagingGatewayClient, typeof sdk.configure);
    `);

    expect(output.trim()).toBe('function function function');
  });

  it('loads with import from an ES module project', () => {
    const output = runInConsumer('consumer.mjs', `
      const { MessagingGatewayEvents, MessagingGatewayClient } = await import('@messaging-gateway/sdk');
      console.log(typeof MessagingGatewayEvents, typeof MessagingGatewayClient);
    `);

    expect(output.trim()).toBe('function function');
  });

  it('has no top-level await in the built modules (required by require(esm))', () => {
    const distDir = join(installedDir, 'dist');
    const files = readdirSync(distDir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.js'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(readFileSync(join(distDir, f), 'utf8'), f).not.toMatch(/^await\s/m);
    }
  });
});
