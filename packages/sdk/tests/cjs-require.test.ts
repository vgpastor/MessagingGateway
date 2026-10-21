import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const distEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url));

describe('package consumable from CommonJS (require(esm), Node >= 22.12)', () => {
  it('exposes a "default" export condition after "import", with "types" first', () => {
    const pkg = JSON.parse(readFileSync(`${pkgDir}package.json`, 'utf8'));
    const root = pkg.exports['.'];
    expect(Object.keys(root)).toEqual(['types', 'import', 'default']);
    expect(root.default).toBe('./dist/index.js');
  });

  it('require() of the built package resolves the events and client classes', () => {
    expect(existsSync(distEntry), 'dist/ is missing: run `npm run build` first (npm test does)').toBe(true);
    const require = createRequire(import.meta.url);
    // Self-reference by package name goes through "exports", exactly like a consumer's require()
    const sdk = require('@messaging-gateway/sdk');
    expect(typeof sdk.MessagingGatewayEvents).toBe('function');
    expect(typeof sdk.MessagingGatewayClient).toBe('function');
  });

  it('has no top-level await in the built modules (required by require(esm))', () => {
    const distDir = fileURLToPath(new URL('../dist/', import.meta.url));
    const files = readdirSync(distDir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.js'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(readFileSync(`${distDir}${f}`, 'utf8'), f).not.toMatch(/^await\s/m);
    }
  });
});
