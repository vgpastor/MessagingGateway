/**
 * Tests for the message store factory: correct driver selection based on config.
 */
import { describe, it, expect } from 'vitest';
import { createMessageStore } from '../../../src/persistence/message-store.factory.js';
import type { EnvConfig } from '../../../src/infrastructure/config/env.config.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rm } from 'node:fs/promises';

function baseConfig(overrides: Partial<EnvConfig> = {}): EnvConfig {
  return {
    port: 3000,
    apiKey: 'test',
    accountsConfigPath: '/tmp/accounts.yaml',
    logLevel: 'info',
    storageEnabled: true,
    storageDriver: 'sqlite',
    databasePath: join(tmpdir(), `mg-factory-test-${Date.now()}.db`),
    ...overrides,
  };
}

describe('createMessageStore', () => {
  it('should create SQLite store when driver is sqlite', async () => {
    const config = baseConfig({ storageDriver: 'sqlite' });
    const store = await createMessageStore(config);

    // Verify it's a working store by calling init
    await store.init();
    const count = await store.count();
    expect(count).toBe(0);
    await store.close();
    await rm(config.databasePath, { force: true }).catch(() => {});
  });

  it('should throw when postgres driver is used without DATABASE_URL', async () => {
    const config = baseConfig({
      storageDriver: 'postgres',
      databaseUrl: undefined,
    });

    await expect(createMessageStore(config)).rejects.toThrow('DATABASE_URL');
  });

  it('should default to sqlite when no driver is specified', async () => {
    const config = baseConfig();
    delete (config as Record<string, unknown>).storageDriver;
    // Factory treats undefined/falsy storageDriver as sqlite (default path)
    const store = await createMessageStore(config);
    await store.init();
    const count = await store.count();
    expect(count).toBe(0);
    await store.close();
    await rm(config.databasePath, { force: true }).catch(() => {});
  });
});
