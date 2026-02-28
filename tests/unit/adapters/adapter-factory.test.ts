import { describe, it, expect } from 'vitest';
import { AdapterFactory } from '../../../src/adapters/adapter.factory.js';
import { AdapterNotFoundError } from '../../../src/domain/errors.js';
import type { MessagingPort } from '../../../src/domain/messaging/messaging.port.js';
import type { ChannelAccount } from '../../../src/domain/accounts/channel-account.js';

class MockAdapter implements MessagingPort {
  constructor(
    public readonly providerConfig: Record<string, unknown>,
    public readonly credentialsRef: string,
  ) {}
  sendMessage = async () => ({ messageId: 'test', status: 'sent' as const, timestamp: new Date() });
  getMessageStatus = async () => ({ messageId: 'test', status: 'sent' as const, timestamp: new Date() });
  downloadMedia = async () => ({ data: Buffer.from(''), mimeType: 'text/plain', size: 0 });
  markAsRead = async () => {};
}

const testAccount: ChannelAccount = {
  id: 'wa-test',
  alias: 'Test',
  channel: 'whatsapp',
  provider: 'wwebjs-api',
  status: 'active',
  identity: { channel: 'whatsapp', phoneNumber: '+34600000001' },
  credentialsRef: 'TEST_CRED',
  providerConfig: { baseUrl: 'http://localhost:3001' },
  metadata: {
    owner: 'test',
    environment: 'production',
    tags: [],
  },
};

describe('AdapterFactory', () => {
  it('should create adapter for registered provider', () => {
    const factory = new AdapterFactory();
    factory.register('wwebjs-api', MockAdapter);

    const adapter = factory.create(testAccount);
    expect(adapter).toBeInstanceOf(MockAdapter);
    expect((adapter as MockAdapter).providerConfig).toEqual({ baseUrl: 'http://localhost:3001' });
    expect((adapter as MockAdapter).credentialsRef).toBe('TEST_CRED');
  });

  it('should throw AdapterNotFoundError for unregistered provider', () => {
    const factory = new AdapterFactory();

    expect(() => factory.create(testAccount)).toThrow(AdapterNotFoundError);
  });

  it('should report adapter availability', () => {
    const factory = new AdapterFactory();
    expect(factory.hasAdapter('wwebjs-api')).toBe(false);

    factory.register('wwebjs-api', MockAdapter);
    expect(factory.hasAdapter('wwebjs-api')).toBe(true);
  });
});
