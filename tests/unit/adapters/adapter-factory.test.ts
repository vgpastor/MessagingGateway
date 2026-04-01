import { describe, it, expect } from 'vitest';
import { ProviderRegistry } from '../../../src/integrations/provider-registry.js';
import { AdapterNotFoundError } from '../../../src/core/errors.js';
import type { MessagingPort } from '../../../src/core/messaging/messaging.port.js';
import type { ChannelAccount } from '../../../src/core/accounts/channel-account.js';
import type { ProviderBundle } from '../../../src/integrations/provider-registry.js';

let lastProviderConfig: Record<string, unknown> | undefined;
let lastCredentialsRef: string | undefined;

const mockBundle: ProviderBundle = {
  id: 'wwebjs-api',
  channel: 'whatsapp',
  displayName: 'Test Provider',
  messaging: (providerConfig, credentialsRef) => {
    lastProviderConfig = providerConfig;
    lastCredentialsRef = credentialsRef;
    return {
      sendMessage: async () => ({ messageId: 'test', status: 'sent' as const, timestamp: new Date() }),
      getMessageStatus: async () => ({ messageId: 'test', status: 'sent' as const, timestamp: new Date() }),
      downloadMedia: async () => ({ data: Buffer.from(''), mimeType: 'text/plain', size: 0 }),
      markAsRead: async () => {},
    } satisfies MessagingPort;
  },
};

const testAccount: ChannelAccount = {
  id: 'wa-test',
  alias: 'Test',
  channel: 'whatsapp',
  provider: 'wwebjs-api',
  status: 'active',
  identity: { channel: 'whatsapp', phoneNumber: '+14155550001' },
  credentialsRef: 'TEST_CRED',
  providerConfig: { baseUrl: 'http://localhost:3001' },
  metadata: { owner: 'test', environment: 'production', tags: [] },
};

describe('ProviderRegistry', () => {
  it('should create adapter for registered provider', () => {
    const registry = new ProviderRegistry();
    registry.register(mockBundle);

    const adapter = registry.create(testAccount);
    expect(adapter).toBeDefined();
    expect(lastProviderConfig).toEqual({ baseUrl: 'http://localhost:3001', accountId: 'wa-test' });
    expect(lastCredentialsRef).toBe('TEST_CRED');
  });

  it('should throw AdapterNotFoundError for unregistered provider', () => {
    const registry = new ProviderRegistry();
    expect(() => registry.create(testAccount)).toThrow(AdapterNotFoundError);
  });

  it('should report provider availability', () => {
    const registry = new ProviderRegistry();
    expect(registry.has('wwebjs-api')).toBe(false);

    registry.register(mockBundle);
    expect(registry.has('wwebjs-api')).toBe(true);
  });
});
