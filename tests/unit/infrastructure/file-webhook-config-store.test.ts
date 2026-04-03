import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { FileWebhookConfigStore } from '../../../src/connections/webhooks/file-webhook-config.store.js';

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
    const store = await FileWebhookConfigStore.create(TEST_FILE);
    const configs = await store.findAll();
    expect(configs).toEqual([]);
  });

  it('should create directory and file on first add', async () => {
    const store = await FileWebhookConfigStore.create(TEST_FILE);

    await store.add('wa-acme', {
      url: 'https://example.com/hook',
      secret: 'my-secret',
    });

    expect(existsSync(TEST_FILE)).toBe(true);
  });

  it('should persist and reload configs', async () => {
    const store1 = await FileWebhookConfigStore.create(TEST_FILE);
    await store1.add('wa-acme', {
      url: 'https://example.com/hook',
      events: ['message.inbound'],
    });

    // Create a new store instance that reads from the same file
    const store2 = await FileWebhookConfigStore.create(TEST_FILE);
    const configs = await store2.findByAccountId('wa-acme');

    expect(configs).toHaveLength(1);
    expect(configs[0]!.accountId).toBe('wa-acme');
    expect(configs[0]!.url).toBe('https://example.com/hook');
    expect(configs[0]!.events).toEqual(['message.inbound']);
    expect(configs[0]!.enabled).toBe(true);
    expect(configs[0]!.id).toBeDefined();
  });

  it('should add multiple webhooks for the same account', async () => {
    vi.useFakeTimers();
    try {
      const store = await FileWebhookConfigStore.create(TEST_FILE);

      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const first = await store.add('wa-acme', { url: 'https://first.com' });

      vi.setSystemTime(new Date('2026-01-01T00:00:01Z'));
      const second = await store.add('wa-acme', { url: 'https://second.com' });

      expect(first.url).toBe('https://first.com');
      expect(second.url).toBe('https://second.com');
      expect(first.id).not.toBe(second.id);

      const configs = await store.findByAccountId('wa-acme');
      expect(configs).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should default events to ["*"] and enabled to true', async () => {
    const store = await FileWebhookConfigStore.create(TEST_FILE);
    const config = await store.add('wa-acme', { url: 'https://example.com' });

    expect(config.events).toEqual(['*']);
    expect(config.enabled).toBe(true);
  });

  it('should remove config by webhookId and persist', async () => {
    const store = await FileWebhookConfigStore.create(TEST_FILE);
    const wh1 = await store.add('wa-acme', { url: 'https://example.com' });
    const wh2 = await store.add('wa-test', { url: 'https://patrol.com' });

    const deleted = await store.remove(wh1.id);
    expect(deleted).toBe(true);

    const all = await store.findAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.accountId).toBe('wa-test');

    // Verify persisted
    const store2 = await FileWebhookConfigStore.create(TEST_FILE);
    expect(await store2.findByAccountId('wa-acme')).toEqual([]);
    const testConfigs = await store2.findByAccountId('wa-test');
    expect(testConfigs).toHaveLength(1);
  });

  it('should return false when removing non-existent config', async () => {
    const store = await FileWebhookConfigStore.create(TEST_FILE);
    const deleted = await store.remove('nonexistent');
    expect(deleted).toBe(false);
  });

  it('should handle corrupted file gracefully', async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(TEST_FILE, 'not valid json', 'utf-8');

    const store = await FileWebhookConfigStore.create(TEST_FILE);
    const configs = await store.findAll();
    expect(configs).toEqual([]);
  });
});
