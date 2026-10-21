import { describe, it, expect, vi } from 'vitest';
import type { ChannelAccount } from '../../../src/core/accounts/channel-account.js';
import { BaileysHealthChecker } from '../../../src/integrations/whatsapp/baileys/baileys.health-checker.js';
import type { BaileysSocketManager } from '../../../src/integrations/whatsapp/baileys/baileys-socket.manager.js';

function makeSocketManager(overrides: Record<string, unknown> = {}) {
  return {
    resolveAuthDir: vi.fn().mockReturnValue('/definitely/not/there'),
    isConnected: vi.fn().mockReturnValue(false),
    ensureConnected: vi.fn().mockReturnValue(true),
    ...overrides,
  };
}

function makeAccount(overrides: Partial<ChannelAccount> = {}): ChannelAccount {
  return {
    id: 'wa-health',
    channel: 'whatsapp',
    provider: 'baileys',
    status: 'active',
    providerConfig: { authDir: 'data/baileys-auth/wa-health' },
    ...overrides,
  } as unknown as ChannelAccount;
}

describe('BaileysHealthChecker reconnection', () => {
  it('health checker reconnects account without socket', async () => {
    const socketManager = makeSocketManager();
    const checker = new BaileysHealthChecker(socketManager as unknown as BaileysSocketManager);

    await checker.validate(makeAccount());

    expect(socketManager.ensureConnected).toHaveBeenCalledTimes(1);
    expect(socketManager.ensureConnected).toHaveBeenCalledWith(
      'wa-health',
      expect.objectContaining({ authDir: 'data/baileys-auth/wa-health' }),
    );
  });

  it('does not touch an account that is already connected', async () => {
    const socketManager = makeSocketManager({ isConnected: vi.fn().mockReturnValue(true) });
    const checker = new BaileysHealthChecker(socketManager as unknown as BaileysSocketManager);

    const result = await checker.validate(makeAccount());

    expect(result.status).toBe('active');
    expect(socketManager.ensureConnected).not.toHaveBeenCalled();
  });

  it('does not reconnect a suspended account', async () => {
    const socketManager = makeSocketManager();
    const checker = new BaileysHealthChecker(socketManager as unknown as BaileysSocketManager);

    await checker.validate(makeAccount({ status: 'suspended' }));

    expect(socketManager.ensureConnected).not.toHaveBeenCalled();
  });

  it('keeps reporting the status even when the reconnect attempt throws', async () => {
    const socketManager = makeSocketManager({
      ensureConnected: vi.fn().mockImplementation(() => { throw new Error('boom'); }),
    });
    const checker = new BaileysHealthChecker(socketManager as unknown as BaileysSocketManager);

    await expect(checker.validate(makeAccount())).resolves.toMatchObject({ status: 'unchecked' });
  });
});
