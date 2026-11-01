import { describe, it, expect } from 'vitest';
import { testDatabaseUrl } from '../../helpers/test-database-url.js';

describe('testDatabaseUrl', () => {
  it('fails in CI when the URL is missing, instead of letting the Postgres tests be skipped', () => {
    expect(() => testDatabaseUrl({ CI: 'true' })).toThrow(/TEST_DATABASE_URL/);
  });

  it('returns the URL in CI', () => {
    expect(testDatabaseUrl({ CI: 'true', TEST_DATABASE_URL: 'postgres://x' })).toBe('postgres://x');
  });

  it('lets them be skipped outside CI', () => {
    expect(testDatabaseUrl({})).toBeUndefined();
  });
});
