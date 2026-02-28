import { describe, it, expect } from 'vitest';
import { matchesRoutingCriteria } from '../../../src/domain/routing/routing-rules.js';
import type { ChannelAccount } from '../../../src/domain/accounts/channel-account.js';

function makeAccount(overrides: Partial<ChannelAccount> = {}): ChannelAccount {
  return {
    id: 'wa-samur',
    alias: 'SAMUR WhatsApp',
    channel: 'whatsapp',
    provider: 'wwebjs-api',
    status: 'active',
    identity: { channel: 'whatsapp', phoneNumber: '+34600000001' },
    credentialsRef: 'WWEBJS_SAMUR',
    providerConfig: {},
    metadata: {
      owner: 'global-emergency',
      environment: 'production',
      tags: ['emergency', 'samur', 'madrid'],
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
    expect(matchesRoutingCriteria(account, { owner: 'global-emergency' })).toBe(true);
    expect(matchesRoutingCriteria(account, { owner: 'patroltech' })).toBe(false);
  });

  it('should match by tags', () => {
    const account = makeAccount();
    expect(matchesRoutingCriteria(account, { tags: ['emergency'] })).toBe(true);
    expect(matchesRoutingCriteria(account, { tags: ['emergency', 'samur'] })).toBe(true);
    expect(matchesRoutingCriteria(account, { tags: ['nonexistent'] })).toBe(false);
  });

  it('should match by multiple criteria', () => {
    const account = makeAccount();
    expect(
      matchesRoutingCriteria(account, {
        channel: 'whatsapp',
        owner: 'global-emergency',
        tags: ['samur'],
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
