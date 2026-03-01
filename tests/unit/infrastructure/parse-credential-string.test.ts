import { describe, it, expect } from 'vitest';
import { parseCredentialString } from '../../../src/infrastructure/config/env.config.js';

describe('parseCredentialString', () => {
  it('should return plain API key when no @ is present', () => {
    const result = parseCredentialString('Pg4k2oSYUQaQZK4m8gTHMlvNrLXatE4D');
    expect(result).toEqual({ apiKey: 'Pg4k2oSYUQaQZK4m8gTHMlvNrLXatE4D' });
  });

  it('should parse user:key@host:port format', () => {
    const result = parseCredentialString('patroltech:Pg4k2oSYUQaQZK4m8gTHMlvNrLXatE4D@srv07.ingenierosweb.co:3011');
    expect(result).toEqual({
      apiKey: 'patroltech:Pg4k2oSYUQaQZK4m8gTHMlvNrLXatE4D',
      baseUrl: 'http://srv07.ingenierosweb.co:3011',
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
