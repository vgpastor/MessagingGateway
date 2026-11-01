import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChannelAccount } from '../../../src/core/accounts/channel-account.js';
import { BaileysHealthChecker } from '../../../src/integrations/whatsapp/baileys/baileys.health-checker.js';
import type { BaileysSocketManager } from '../../../src/integrations/whatsapp/baileys/baileys-socket.manager.js';

function makeSocketManager(overrides: Record<string, unknown> = {}) {
  return {
    resolveAuthDir: vi.fn().mockReturnValue('/definitely/not/there'),
    isConnected: vi.fn().mockReturnValue(false),
    ensureConnected: vi.fn().mockReturnValue(true),
    getLastQr: vi.fn().mockReturnValue(undefined),
    getConnectionEnd: vi.fn().mockReturnValue(undefined),
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

describe('BaileysHealthChecker verdict', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mg-health-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const withAuthDir = (overrides: Record<string, unknown> = {}) => new BaileysHealthChecker(
    makeSocketManager({ resolveAuthDir: vi.fn().mockReturnValue(dir), ...overrides }) as unknown as BaileysSocketManager,
  );

  it('an auth dir without credentials is not a stored session: opening a socket creates that dir', async () => {
    const result = await withAuthDir().validate(makeAccount());

    expect(result).toMatchObject({ status: 'unchecked', credentialsConfigured: false });
  });

  it('a stored session that is not connected right now settles nothing: the account keeps its status', async () => {
    await writeFile(join(dir, 'creds.json'), '{}');

    expect(await withAuthDir().validate(makeAccount({ status: 'active' }))).toMatchObject({ status: 'active', credentialsConfigured: true });
    expect(await withAuthDir().validate(makeAccount({ status: 'unchecked' }))).toMatchObject({ status: 'unchecked', credentialsConfigured: true });
  });

  it.each(['session_lost', 'closed'])('a connection ended (%s) is auth_expired, and does not claim to be reconnecting', async (end) => {
    await writeFile(join(dir, 'creds.json'), '{}');

    const result = await withAuthDir({ getConnectionEnd: vi.fn().mockReturnValue(end) }).validate(makeAccount());

    expect(result.status).toBe('auth_expired');
    expect(result.detail).not.toMatch(/in progress/i);
    expect(result.detail).toContain('/reset');
  });

  it('an account showing a QR is waiting to be paired, whatever is on disk', async () => {
    await writeFile(join(dir, 'creds.json'), '{}');

    const result = await withAuthDir({ getLastQr: vi.fn().mockReturnValue('QR') }).validate(makeAccount());

    expect(result).toMatchObject({ status: 'unchecked', credentialsConfigured: false });
  });
});
