import { describe, it, expect, vi } from 'vitest';
import { BaileysConnectionManager } from '../../../src/integrations/whatsapp/baileys/baileys.connection-manager.js';
import type { BaileysSocketManager } from '../../../src/integrations/whatsapp/baileys/baileys-socket.manager.js';

function makeSocketManagerStub() {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    clearSession: vi.fn().mockResolvedValue(undefined),
    hasSocket: vi.fn().mockReturnValue(false),
    getConnectionStatus: vi.fn().mockReturnValue('disconnected'),
    getLastQr: vi.fn().mockReturnValue(undefined),
    requestPairingCode: vi.fn().mockResolvedValue('ABCD-1234'),
    getGroups: vi.fn().mockResolvedValue([]),
    getGroupInfo: vi.fn().mockResolvedValue(undefined),
  } as unknown as BaileysSocketManager;
}

describe('BaileysConnectionManager session reset', () => {
  it('clearSession delegates to the socket manager with the parsed provider config', async () => {
    const socketManager = makeSocketManagerStub();
    const manager = new BaileysConnectionManager(socketManager);

    await manager.clearSession('wa-test', { authDir: 'data/baileys-auth/wa-test' });

    const clearSession = socketManager.clearSession as unknown as ReturnType<typeof vi.fn>;
    expect(clearSession).toHaveBeenCalledTimes(1);
    const [accountId, config] = clearSession.mock.calls[0];
    expect(accountId).toBe('wa-test');
    expect(config).toMatchObject({ authDir: 'data/baileys-auth/wa-test' });
  });

  it('exposes clearSession as an optional port capability', () => {
    const manager = new BaileysConnectionManager(makeSocketManagerStub());
    expect(typeof manager.clearSession).toBe('function');
  });
});
