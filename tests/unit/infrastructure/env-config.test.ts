import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadEnvConfig } from '../../../src/infrastructure/config/env.config.js';

describe('loadEnvConfig retention', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env['API_KEY'] = 'test-key';
    delete process.env['MEDIA_RETENTION_DAYS'];
    delete process.env['MESSAGE_RETENTION_DAYS'];
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('defaults to 30 days of media and 180 days of messages', () => {
    const cfg = loadEnvConfig();
    expect(cfg.mediaRetentionDays).toBe(30);
    expect(cfg.messageRetentionDays).toBe(180);
  });

  it('reads explicit values', () => {
    process.env['MEDIA_RETENTION_DAYS'] = '7';
    process.env['MESSAGE_RETENTION_DAYS'] = '90';
    const cfg = loadEnvConfig();
    expect(cfg.mediaRetentionDays).toBe(7);
    expect(cfg.messageRetentionDays).toBe(90);
  });

  it('0 is kept as 0 (retention disabled), not replaced by the default', () => {
    process.env['MEDIA_RETENTION_DAYS'] = '0';
    process.env['MESSAGE_RETENTION_DAYS'] = '0';
    const cfg = loadEnvConfig();
    expect(cfg.mediaRetentionDays).toBe(0);
    expect(cfg.messageRetentionDays).toBe(0);
  });

  it('a negative value disables retention too', () => {
    process.env['MESSAGE_RETENTION_DAYS'] = '-5';
    expect(loadEnvConfig().messageRetentionDays).toBe(0);
  });

  it('garbage falls back to the default', () => {
    process.env['MESSAGE_RETENTION_DAYS'] = 'soon';
    expect(loadEnvConfig().messageRetentionDays).toBe(180);
  });
});

describe('loadEnvConfig read-only key', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env['API_KEY'] = 'test-key';
    delete process.env['READ_API_KEY'];
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('is undefined when READ_API_KEY is unset or empty', () => {
    expect(loadEnvConfig().readApiKey).toBeUndefined();
    process.env['READ_API_KEY'] = '';
    expect(loadEnvConfig().readApiKey).toBeUndefined();
  });

  it('reads READ_API_KEY', () => {
    process.env['READ_API_KEY'] = 'read-only-key';
    expect(loadEnvConfig().readApiKey).toBe('read-only-key');
  });
});
