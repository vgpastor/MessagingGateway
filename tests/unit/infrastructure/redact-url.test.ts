import { describe, it, expect } from 'vitest';
import { redactUrl } from '../../../src/infrastructure/logging/redact-url.js';

describe('redactUrl', () => {
  it('leaves URLs without a query untouched', () => {
    expect(redactUrl('/ws/events')).toBe('/ws/events');
  });

  it('redacts a plain token', () => {
    expect(redactUrl('/ws/events?token=SECRET')).toBe('/ws/events?token=***');
  });

  it('keeps the other parameters', () => {
    expect(redactUrl('/ws/events?a=1&token=SECRET&b=2')).toBe('/ws/events?a=1&token=***&b=2');
  });

  it.each([
    '/ws/events?%74oken=SECRET',
    '/ws/events?%54OKEN=SECRET',
    '/ws/events?TOKEN=SECRET',
    '/ws/events?a=1&%74%6f%6b%65%6e=SECRET&b=2',
    '/ws/events?token=SECRET&token=SECRET2',
    '/ws/events?token=SECRET#frag',
  ])('never lets the key through: %s', (url) => {
    const out = redactUrl(url);
    expect(out).not.toContain('SECRET');
  });

  it('a malformed escape in another value does not stop the token being redacted', () => {
    const out = redactUrl('/ws/events?x=%E0%A4%A&token=SECRET');
    expect(out).not.toContain('SECRET');
    expect(out).toBe('/ws/events?x=%E0%A4%A&token=***');
  });

  it('a malformed escape in a parameter name drops the whole query', () => {
    expect(redactUrl('/ws/events?%zz=1&token=SECRET')).toBe('/ws/events');
    expect(redactUrl('/ws/events?%E0%A4%A=1&%74oken=SECRET')).toBe('/ws/events');
  });

  it('does not touch parameters that merely contain "token"', () => {
    expect(redactUrl('/x?tokens=1&mytoken=2')).toBe('/x?tokens=1&mytoken=2');
  });
});
