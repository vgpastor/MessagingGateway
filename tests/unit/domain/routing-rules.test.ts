import { describe, it, expect } from 'vitest';
import { matchesRoutingCriteria } from '../../../src/core/routing/routing-rules.js';
import type { ChannelAccount } from '../../../src/core/accounts/channel-account.js';

function makeAccount(overrides: Partial<ChannelAccount> = {}): ChannelAccount {
  return {
    id: 'wa-acme',
    alias: 'Acme WhatsApp',
    channel: 'whatsapp',
    provider: 'wwebjs-api',
    status: 'active',
    identity: { channel: 'whatsapp', phoneNumber: '+34600000001' },
    credentialsRef: 'WWEBJS_ACME',
    providerConfig: {},
    metadata: {
      owner: 'acme-corp',
      environment: 'production',
      tags: ['support', 'acme'],
    },
    ...overrides,
  };
}

describe('matchesRoutingCriteria', () => {
  it('should match when no criteria specified', () => {
    const account = makeAccount();
    expect(matchesRoutingCriteria(account, {})).toBe(true);
  });

  it('should match by channel', () => {
    const account = makeAccount({ channel: 'whatsapp' });
    expect(matchesRoutingCriteria(account, { channel: 'whatsapp' })).toBe(true);
    expect(matchesRoutingCriteria(account, { channel: 'telegram' })).toBe(false);
  });

  it('should match by owner', () => {
    const account = makeAccount();
    expect(matchesRoutingCriteria(account, { owner: 'acme-corp' })).toBe(true);
    expect(matchesRoutingCriteria(account, { owner: 'test-org' })).toBe(false);
  });

  it('should match by tags', () => {
    const account = makeAccount();
    expect(matchesRoutingCriteria(account, { tags: ['support'] })).toBe(true);
    expect(matchesRoutingCriteria(account, { tags: ['support', 'acme'] })).toBe(true);
    expect(matchesRoutingCriteria(account, { tags: ['nonexistent'] })).toBe(false);
  });

  it('should match by multiple criteria', () => {
    const account = makeAccount();
    expect(
      matchesRoutingCriteria(account, {
        channel: 'whatsapp',
        owner: 'acme-corp',
        tags: ['acme'],
      }),
    ).toBe(true);

    expect(
      matchesRoutingCriteria(account, {
        channel: 'whatsapp',
        owner: 'wrong-owner',
      }),
    ).toBe(false);
  });
});
