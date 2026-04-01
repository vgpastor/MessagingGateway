import { describe, it, expect } from 'vitest';
import { ProviderRegistry } from '../../../src/integrations/provider-registry.js';
import type { ProviderBundle } from '../../../src/integrations/provider-registry.js';
import { AdapterNotFoundError } from '../../../src/core/errors.js';

const mockBundle: ProviderBundle = {
  id: 'test-provider',
  channel: 'whatsapp',
  displayName: 'Test Provider',
  messaging: () => ({
    sendMessage: async () => ({ messageId: 't', status: 'sent' as const, timestamp: new Date() }),
    getMessageStatus: async () => ({ messageId: 't', status: 'sent' as const, timestamp: new Date() }),
    downloadMedia: async () => ({ data: Buffer.from(''), mimeType: 'text/plain', size: 0 }),
    markAsRead: async () => {},
  }),
  health: () => ({
    validate: async () => ({ status: 'active' as const, credentialsConfigured: true }),
  }),
  connection: () => ({
    supports: () => true,
    connect: async () => {},
    getConnectionInfo: () => ({ status: 'connected' as const }),
    hasConnection: () => true,
    requestPairingCode: async () => '123456',
    disconnect: async () => {},
  }),
  inbound: () => ({
    parseIncoming: (raw: unknown) => raw,
    validateSignature: () => true,
    toEnvelope: () => ({} as any),
  }),
};

const minimalBundle: ProviderBundle = {
  id: 'minimal-provider',
  channel: 'sms',
  displayName: 'Minimal Provider',
  messaging: () => { throw new Error('not implemented'); },
};

describe('ProviderRegistry', () => {
  it('should register and retrieve a provider bundle', () => {
    const registry = new ProviderRegistry();
    registry.register(mockBundle);

    expect(registry.get('test-provider')).toBe(mockBundle);
    expect(registry.has('test-provider')).toBe(true);
  });

  it('should return undefined for unknown provider', () => {
    const registry = new ProviderRegistry();
    expect(registry.get('unknown')).toBeUndefined();
    expect(registry.has('unknown')).toBe(false);
  });

  it('should throw AdapterNotFoundError from getOrThrow', () => {
    const registry = new ProviderRegistry();
    expect(() => registry.getOrThrow('missing')).toThrow(AdapterNotFoundError);
  });

  it('should list all registered providers', () => {
    const registry = new ProviderRegistry();
    registry.register(mockBundle);
    registry.register(minimalBundle);

    const list = registry.listProviders();
    expect(list).toHaveLength(2);
    expect(list.map((p) => p.id)).toEqual(['test-provider', 'minimal-provider']);
  });

  it('should return health checker from bundle', () => {
    const registry = new ProviderRegistry();
    registry.register(mockBundle);

    const checker = registry.getHealthChecker('test-provider');
    expect(checker).toBeDefined();
    expect(checker!.validate).toBeTypeOf('function');
  });

  it('should return undefined health checker for bundle without health', () => {
    const registry = new ProviderRegistry();
    registry.register(minimalBundle);

    expect(registry.getHealthChecker('minimal-provider')).toBeUndefined();
  });

  it('should return connection manager from bundle', () => {
    const registry = new ProviderRegistry();
    registry.register(mockBundle);

    const manager = registry.getConnectionManager('test-provider');
    expect(manager).toBeDefined();
    expect(manager!.connect).toBeTypeOf('function');
  });

  it('should return undefined connection manager for bundle without connection', () => {
    const registry = new ProviderRegistry();
    registry.register(minimalBundle);

    expect(registry.getConnectionManager('minimal-provider')).toBeUndefined();
  });

  it('should return inbound adapter from bundle', () => {
    const registry = new ProviderRegistry();
    registry.register(mockBundle);

    const adapter = registry.getInboundAdapter('test-provider');
    expect(adapter).toBeDefined();
    expect(adapter!.parseIncoming).toBeTypeOf('function');
  });

  it('should return undefined inbound adapter for bundle without inbound', () => {
    const registry = new ProviderRegistry();
    registry.register(minimalBundle);

    expect(registry.getInboundAdapter('minimal-provider')).toBeUndefined();
  });

  it('should create messaging adapter with accountId injected', () => {
    const registry = new ProviderRegistry();
    let capturedConfig: Record<string, unknown> | undefined;

    registry.register({
      ...mockBundle,
      messaging: (config) => { capturedConfig = config; return mockBundle.messaging(config, '', ''); },
    });

    registry.create({
      id: 'my-account', alias: 'Test', channel: 'whatsapp', provider: 'test-provider',
      status: 'active', identity: { channel: 'whatsapp', phoneNumber: '' },
      credentialsRef: 'CRED', providerConfig: { baseUrl: 'http://test' },
      metadata: { owner: 'test', environment: 'production', tags: [] },
    });

    expect(capturedConfig).toEqual({ baseUrl: 'http://test', accountId: 'my-account' });
  });
});
