import { describe, it, expect } from 'vitest';
import { parseCredentialString } from '../../../src/infrastructure/config/env.config.js';

describe('parseCredentialString', () => {
  it('should return plain API key when no @ is present', () => {
    const result = parseCredentialString('sk_test_abc123def456');
    expect(result).toEqual({ apiKey: 'sk_test_abc123def456' });
  });

  it('should parse user:key@host:port format', () => {
    const result = parseCredentialString('myuser:sk_test_abc123def456@api.example.com:3011');
    expect(result).toEqual({
      apiKey: 'myuser:sk_test_abc123def456',
      baseUrl: 'http://api.example.com:3011',
    });
  });

  it('should parse key@host:port format', () => {
    const result = parseCredentialString('myapikey@example.com:8080');
    expect(result).toEqual({
      apiKey: 'myapikey',
      baseUrl: 'http://example.com:8080',
    });
  });

  it('should preserve explicit http/https in host part', () => {
    const result = parseCredentialString('mykey@https://secure.host.com:443');
    expect(result).toEqual({
      apiKey: 'mykey',
      baseUrl: 'https://secure.host.com:443',
    });
  });

  it('should return raw string as apiKey when @ is at the start', () => {
    const result = parseCredentialString('@host:3000');
    expect(result).toEqual({ apiKey: '@host:3000' });
  });

  it('should return raw string as apiKey when @ is at the end', () => {
    const result = parseCredentialString('mykey@');
    expect(result).toEqual({ apiKey: 'mykey@' });
  });

  it('should use last @ when multiple @ are present', () => {
    const result = parseCredentialString('user@org:key@host:3000');
    expect(result).toEqual({
      apiKey: 'user@org:key',
      baseUrl: 'http://host:3000',
    });
  });
});
