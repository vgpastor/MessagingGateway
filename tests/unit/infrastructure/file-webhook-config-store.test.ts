import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { FileWebhookConfigStore } from '../../../src/infrastructure/webhooks/file-webhook-config.store.js';

const TEST_DIR = resolve(process.cwd(), 'tmp-test-webhooks');
const TEST_FILE = resolve(TEST_DIR, 'webhooks.json');

describe('FileWebhookConfigStore', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  it('should start empty when file does not exist', async () => {
    const store = new FileWebhookConfigStore(TEST_FILE);
    const configs = await store.findAll();
    expect(configs).toEqual([]);
  });

  it('should create directory and file on first upsert', async () => {
    const store = new FileWebhookConfigStore(TEST_FILE);

    await store.upsert('wa-samur', {
      url: 'https://example.com/hook',
      secret: 'my-secret',
    });

    expect(existsSync(TEST_FILE)).toBe(true);
  });

  it('should persist and reload configs', async () => {
    const store1 = new FileWebhookConfigStore(TEST_FILE);
    await store1.upsert('wa-samur', {
      url: 'https://example.com/hook',
      events: ['message.inbound'],
    });

    // Create a new store instance that reads from the same file
    const store2 = new FileWebhookConfigStore(TEST_FILE);
    const config = await store2.findByAccountId('wa-samur');

    expect(config).toBeDefined();
    expect(config!.accountId).toBe('wa-samur');
    expect(config!.url).toBe('https://example.com/hook');
    expect(config!.events).toEqual(['message.inbound']);
    expect(config!.enabled).toBe(true);
  });

  it('should update existing config preserving createdAt', async () => {
    const store = new FileWebhookConfigStore(TEST_FILE);

    const created = await store.upsert('wa-samur', { url: 'https://first.com' });
    const updated = await store.upsert('wa-samur', { url: 'https://second.com' });

    expect(updated.url).toBe('https://second.com');
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt).not.toBe(created.updatedAt);
  });

  it('should default events to ["*"] and enabled to true', async () => {
    const store = new FileWebhookConfigStore(TEST_FILE);
    const config = await store.upsert('wa-samur', { url: 'https://example.com' });

    expect(config.events).toEqual(['*']);
    expect(config.enabled).toBe(true);
  });

  it('should remove config and persist', async () => {
    const store = new FileWebhookConfigStore(TEST_FILE);
    await store.upsert('wa-samur', { url: 'https://example.com' });
    await store.upsert('wa-patroltech', { url: 'https://patrol.com' });

    const deleted = await store.remove('wa-samur');
    expect(deleted).toBe(true);

    const all = await store.findAll();
    expect(all).toHaveLength(1);
    expect(all[0].accountId).toBe('wa-patroltech');

    // Verify persisted
    const store2 = new FileWebhookConfigStore(TEST_FILE);
    expect(await store2.findByAccountId('wa-samur')).toBeUndefined();
    expect(await store2.findByAccountId('wa-patroltech')).toBeDefined();
  });

  it('should return false when removing non-existent config', async () => {
    const store = new FileWebhookConfigStore(TEST_FILE);
    const deleted = await store.remove('nonexistent');
    expect(deleted).toBe(false);
  });

  it('should handle corrupted file gracefully', async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(TEST_FILE, 'not valid json', 'utf-8');

    const store = new FileWebhookConfigStore(TEST_FILE);
    const configs = await store.findAll();
    expect(configs).toEqual([]);
  });
});
