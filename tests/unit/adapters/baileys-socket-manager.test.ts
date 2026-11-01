import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { BaileysSocketManager } from '../../../src/integrations/whatsapp/baileys/baileys-socket.manager.js';
import { getLogger, setGlobalLogger, type Logger } from '../../../src/core/logger/logger.port.js';

// A fake WhatsApp socket per makeWASocket() call; tests drive its 'connection.update'.
interface FakeSocket { ev: EventEmitter; end: () => void; logout: () => Promise<void> }
const fakeSockets: FakeSocket[] = [];
const auth = { saveCreds: (): unknown => undefined };

vi.mock('@whiskeysockets/baileys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@whiskeysockets/baileys')>()),
  default: () => {
    const socket: FakeSocket = { ev: new EventEmitter(), end: () => {}, logout: async () => {} };
    fakeSockets.push(socket);
    return socket;
  },
  useMultiFileAuthState: async () => ({ state: {}, saveCreds: () => auth.saveCreds() }),
  fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
}));

const ACCOUNT_ID = 'test-clear-session';
const authDir = resolve(process.cwd(), 'data', 'baileys-auth', ACCOUNT_ID);

describe('BaileysSocketManager.clearSession', () => {
  afterEach(async () => {
    await rm(authDir, { recursive: true, force: true });
  });

  it('deletes the on-disk auth dir so the next connect starts fresh', async () => {
    const manager = new BaileysSocketManager();
    await mkdir(authDir, { recursive: true });
    await writeFile(resolve(authDir, 'creds.json'), '{}');
    expect(existsSync(authDir)).toBe(true);

    await manager.clearSession(ACCOUNT_ID, {});

    expect(existsSync(authDir)).toBe(false);
  });

  it('refuses to delete an auth dir outside the managed root (path traversal)', async () => {
    const manager = new BaileysSocketManager();

    await expect(
      manager.clearSession('evil', { authDir: '../../../tmp/evil' }),
    ).rejects.toMatchObject({ code: 'INVALID_AUTH_DIR' });
  });

  it('keeps the inbound subscriptions so a re-paired account still delivers messages', async () => {
    const manager = new BaileysSocketManager();
    await mkdir(authDir, { recursive: true });
    await writeFile(resolve(authDir, 'creds.json'), '{}');

    manager.onMessage(ACCOUNT_ID, () => {});

    await manager.clearSession(ACCOUNT_ID, {});

    // The socket is gone, but the account's handler must survive the teardown:
    // the reconnect that follows a reset re-creates the entry from scratch.
    expect(handlersFor(manager, ACCOUNT_ID)).toHaveLength(1);
  });
});

describe('BaileysSocketManager.closeAll', () => {
  const CLOSE_ID = 'test-close-all';
  const closeAuthDir = resolve(process.cwd(), 'data', 'baileys-auth', CLOSE_ID);

  afterEach(async () => {
    vi.useRealTimers();
    fakeSockets.length = 0;
    await rm(closeAuthDir, { recursive: true, force: true });
  });

  async function connected(manager: BaileysSocketManager) {
    await manager.connect(CLOSE_ID, {});
    const socket = fakeSockets.at(-1)!;
    const end = vi.spyOn(socket, 'end');
    const logout = vi.spyOn(socket, 'logout');
    return { socket, end, logout };
  }

  it('closes the socket without logging out and keeps the auth state, so the next start resumes the session', async () => {
    const manager = new BaileysSocketManager();
    const { end, logout } = await connected(manager);
    await writeFile(resolve(closeAuthDir, 'creds.json'), '{}');

    manager.closeAll();

    expect(end).toHaveBeenCalledTimes(1);
    expect(logout).not.toHaveBeenCalled();
    expect(existsSync(resolve(closeAuthDir, 'creds.json'))).toBe(true);
    expect(manager.hasSocket(CLOSE_ID)).toBe(false);
  });

  it('does not reconnect: neither from the close event nor from a timer already scheduled', async () => {
    vi.useFakeTimers();
    const manager = new BaileysSocketManager({ random: () => 0.5 });
    const { socket } = await connected(manager);
    const before = fakeSockets.length;
    socket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: new Error('blip') } });

    manager.closeAll();
    socket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: new Error('closed') } });
    await vi.advanceTimersByTimeAsync(600_000);

    expect(fakeSockets.length).toBe(before);
  });

  it('refuses to open a socket afterwards', async () => {
    const manager = new BaileysSocketManager();
    manager.closeAll();
    const before = fakeSockets.length;

    await manager.connect(CLOSE_ID, {});

    expect(fakeSockets.length).toBe(before);
    expect(manager.hasSocket(CLOSE_ID)).toBe(false);
  });

  it('does not open the socket of a connect that was already in flight', async () => {
    const manager = new BaileysSocketManager();
    const before = fakeSockets.length;

    const connecting = manager.connect(CLOSE_ID, {});
    manager.closeAll();
    await connecting;

    expect(fakeSockets.length).toBe(before);
  });
});

describe('BaileysSocketManager containment', () => {
  const ID = 'test-containment';
  const original = getLogger();
  const flush = () => new Promise((r) => setImmediate(r));

  afterEach(async () => {
    setGlobalLogger(original);
    auth.saveCreds = () => undefined;
    fakeSockets.length = 0;
    await rm(resolve(process.cwd(), 'data', 'baileys-auth', ID), { recursive: true, force: true });
  });

  it('logs a failed credentials write instead of leaving a rejection that would end the process', async () => {
    const error = vi.fn();
    setGlobalLogger({ ...original, error } as unknown as Logger);
    auth.saveCreds = () => Promise.reject(new Error('ENOSPC'));
    const manager = new BaileysSocketManager();
    await manager.connect(ID, {});

    fakeSockets.at(-1)!.ev.emit('creds.update', {});
    await flush();

    expect(error).toHaveBeenCalledWith('Failed to save credentials', expect.objectContaining({ accountId: ID, error: 'ENOSPC' }));
  });

  it('one handler throwing does not stop the others nor reach Baileys', async () => {
    const manager = new BaileysSocketManager();
    const next = vi.fn();
    const nextMessage = vi.fn();
    manager.onConnectionUpdate(ID, () => { throw new Error('bad handler'); });
    manager.onConnectionUpdate(ID, next);
    manager.onMessage(ID, () => { throw new Error('bad handler'); });
    manager.onMessage(ID, nextMessage);
    await manager.connect(ID, {});
    const { ev } = fakeSockets.at(-1)!;

    expect(() => ev.emit('connection.update', { connection: 'open' })).not.toThrow();
    expect(() => ev.emit('messages.upsert', { messages: [], type: 'notify' })).not.toThrow();

    expect(next).toHaveBeenCalledTimes(1);
    expect(nextMessage).toHaveBeenCalledTimes(1);
  });
});

describe('BaileysSocketManager subscriptions', () => {
  it('accepts a handler registered before the first connect', () => {
    const manager = new BaileysSocketManager();

    manager.onMessage('never-connected', () => {});
    manager.onConnectionUpdate('never-connected', () => {});

    expect(handlersFor(manager, 'never-connected')).toHaveLength(1);
    expect(connectionHandlersFor(manager, 'never-connected')).toHaveLength(1);
  });

  it('drops the subscriptions once the device is unlinked', async () => {
    const manager = new BaileysSocketManager();
    manager.onMessage('gone', () => {});

    await manager.disconnect('gone');

    expect(handlersFor(manager, 'gone')).toHaveLength(0);
  });
});

/** The registries are private state; reach in rather than exposing them just for tests. */
function handlersFor(manager: BaileysSocketManager, accountId: string): unknown[] {
  const registry = (manager as unknown as { messageHandlers: Map<string, unknown[]> }).messageHandlers;
  return registry.get(accountId) ?? [];
}

function connectionHandlersFor(manager: BaileysSocketManager, accountId: string): unknown[] {
  const registry = (manager as unknown as { connectionHandlers: Map<string, unknown[]> }).connectionHandlers;
  return registry.get(accountId) ?? [];
}

describe('BaileysSocketManager reconnection', () => {
  const RECONNECT_ID = 'test-reconnect';
  const reconnectAuthDir = resolve(process.cwd(), 'data', 'baileys-auth', RECONNECT_ID);
  // Only timeouts are faked: connect() does real fs I/O that must keep flowing.
  const realSetTimeout = setTimeout;
  const realSleep = (ms: number) => new Promise<void>((r) => realSetTimeout(r, ms));
  const settle = () => realSleep(50); // lets any wrongly-triggered connect finish before a negative assertion
  const maxJitter = () => 1;

  afterEach(async () => {
    vi.useRealTimers();
    fakeSockets.length = 0;
    await rm(reconnectAuthDir, { recursive: true, force: true });
  });

  function useFakeTimeouts(): void {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  }

  /** Let the real fs/promise work behind connect() settle until `count` sockets exist. */
  async function waitForSockets(count: number): Promise<void> {
    for (let i = 0; i < 1000 && fakeSockets.length < count; i++) {
      await realSleep(5);
    }
    expect(fakeSockets.length).toBe(count);
    await realSleep(20); // room for any unwanted extra connect to show up
  }

  const close = (statusCode: number) => ({
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode } }, date: new Date() },
  });

  async function connected(manager: BaileysSocketManager, config = {}): Promise<void> {
    await manager.connect(RECONNECT_ID, config);
    await waitForSockets(1);
  }

  it('reconnects indefinitely on transient close codes', async () => {
    useFakeTimeouts();
    const manager = new BaileysSocketManager({ random: maxJitter });
    const connect = vi.spyOn(manager, 'connect');
    await connected(manager);

    for (let i = 1; i <= 10; i++) {
      fakeSockets[i - 1]!.ev.emit('connection.update', close(428));
      // Far beyond the 5-attempt ceiling of the old logic, and still scheduled.
      await vi.advanceTimersByTimeAsync(300_000);
      await waitForSockets(i + 1);
      expect(manager.hasSocket(RECONNECT_ID)).toBe(true);
    }

    expect(connect).toHaveBeenCalledTimes(11); // the first connect + 10 reconnects
  });

  it('keeps the account in sockets while it waits for the next attempt', async () => {
    useFakeTimeouts();
    const manager = new BaileysSocketManager({ random: maxJitter });
    await connected(manager);

    fakeSockets[0]!.ev.emit('connection.update', close(503));

    expect(manager.hasSocket(RECONNECT_ID)).toBe(true);
    expect(manager.getConnectionStatus(RECONNECT_ID)).toBe('disconnected');
  });

  it('backs off exponentially between consecutive failures', async () => {
    useFakeTimeouts();
    const manager = new BaileysSocketManager({ random: maxJitter });
    await connected(manager);

    // attempt 0 -> 1000ms
    fakeSockets[0]!.ev.emit('connection.update', close(428));
    await vi.advanceTimersByTimeAsync(999);
    await settle();
    expect(fakeSockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await waitForSockets(2);

    // attempt 1 -> 2000ms
    fakeSockets[1]!.ev.emit('connection.update', close(428));
    await vi.advanceTimersByTimeAsync(1999);
    await settle();
    expect(fakeSockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await waitForSockets(3);
  });

  it('resets the attempt counter once the connection opens', async () => {
    useFakeTimeouts();
    const manager = new BaileysSocketManager({ random: maxJitter });
    await connected(manager);

    for (let i = 0; i < 3; i++) {
      fakeSockets[i]!.ev.emit('connection.update', close(428));
      await vi.advanceTimersByTimeAsync(300_000);
      await waitForSockets(i + 2);
    }
    fakeSockets[3]!.ev.emit('connection.update', { connection: 'open' });

    // Without the reset this would wait for attempt 3 (8000ms).
    fakeSockets[3]!.ev.emit('connection.update', close(428));
    await vi.advanceTimersByTimeAsync(1000);
    await waitForSockets(5);
  });

  it('does not reconnect on loggedOut 401', async () => {
    useFakeTimeouts();
    const manager = new BaileysSocketManager({ random: maxJitter });
    const connect = vi.spyOn(manager, 'connect');
    await connected(manager);

    fakeSockets[0]!.ev.emit('connection.update', close(401));
    await vi.advanceTimersByTimeAsync(600_000);
    await settle();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(fakeSockets).toHaveLength(1);
    expect(manager.hasSocket(RECONNECT_ID)).toBe(false);
  });

  it('does not reconnect when retryOnDisconnect is false', async () => {
    useFakeTimeouts();
    const manager = new BaileysSocketManager({ random: maxJitter });
    await connected(manager, { retryOnDisconnect: false });

    fakeSockets[0]!.ev.emit('connection.update', close(428));
    await vi.advanceTimersByTimeAsync(600_000);
    await settle();

    expect(fakeSockets).toHaveLength(1);
    expect(manager.hasSocket(RECONNECT_ID)).toBe(false);
  });

  it('schedules a single reconnect even if the dead socket reports close twice', async () => {
    useFakeTimeouts();
    const manager = new BaileysSocketManager({ random: maxJitter });
    await connected(manager);

    fakeSockets[0]!.ev.emit('connection.update', close(428));
    fakeSockets[0]!.ev.emit('connection.update', close(428));
    await vi.advanceTimersByTimeAsync(300_000);
    await waitForSockets(2);
    await vi.advanceTimersByTimeAsync(300_000);

    expect(fakeSockets).toHaveLength(2);
  });

  it('cancels a pending reconnect when the account is disconnected', async () => {
    useFakeTimeouts();
    const manager = new BaileysSocketManager({ random: maxJitter });
    await connected(manager);

    fakeSockets[0]!.ev.emit('connection.update', close(428));
    await manager.disconnect(RECONNECT_ID);
    await vi.advanceTimersByTimeAsync(600_000);
    await settle();

    expect(fakeSockets).toHaveLength(1);
    expect(manager.hasSocket(RECONNECT_ID)).toBe(false);
  });

  it('retries with backoff when opening the socket itself fails', async () => {
    useFakeTimeouts();
    const manager = new BaileysSocketManager({ random: maxJitter });
    const connect = vi.spyOn(manager, 'connect');
    await connected(manager);

    connect.mockRejectedValueOnce(new Error('transient fs error'));
    fakeSockets[0]!.ev.emit('connection.update', close(428));
    await vi.advanceTimersByTimeAsync(1000); // first retry fails
    await vi.advanceTimersByTimeAsync(2000); // second retry succeeds
    await waitForSockets(2);

    expect(connect).toHaveBeenCalledTimes(3);
  });

  describe('ensureConnected', () => {
    it('does not open a socket before the account event wiring exists', async () => {
      const manager = new BaileysSocketManager();

      expect(manager.ensureConnected(RECONNECT_ID, {})).toBe(false);
      await settle();

      expect(fakeSockets).toHaveLength(0);
    });

    it('opens a socket for an account that has none', async () => {
      const manager = new BaileysSocketManager();
      manager.onConnectionUpdate(RECONNECT_ID, () => {});

      expect(manager.ensureConnected(RECONNECT_ID, {})).toBe(true);
      await waitForSockets(1);

      expect(manager.hasSocket(RECONNECT_ID)).toBe(true);
    });

    it('does nothing when the account already has a socket', async () => {
      const manager = new BaileysSocketManager();
      manager.onConnectionUpdate(RECONNECT_ID, () => {});
      await connected(manager);

      expect(manager.ensureConnected(RECONNECT_ID, {})).toBe(false);
      await waitForSockets(1);
    });

    it('does not stack a second connect while one is in progress', async () => {
      const manager = new BaileysSocketManager();
      manager.onConnectionUpdate(RECONNECT_ID, () => {});
      const connect = vi.spyOn(manager, 'connect');

      expect(manager.ensureConnected(RECONNECT_ID, {})).toBe(true);
      expect(manager.ensureConnected(RECONNECT_ID, {})).toBe(false);
      await waitForSockets(1);

      expect(connect).toHaveBeenCalledTimes(1);
    });

    it('does not race a reconnect that is already scheduled', async () => {
      useFakeTimeouts();
      const manager = new BaileysSocketManager({ random: maxJitter });
      manager.onConnectionUpdate(RECONNECT_ID, () => {});
      await connected(manager);
      fakeSockets[0]!.ev.emit('connection.update', close(428));
      // Even if the stale entry were gone, the pending timer owns the next attempt.
      (manager as unknown as { sockets: Map<string, unknown> }).sockets.delete(RECONNECT_ID);

      expect(manager.ensureConnected(RECONNECT_ID, {})).toBe(false);
    });

    it('refuses to resurrect a logged-out account', async () => {
      const manager = new BaileysSocketManager();
      manager.onConnectionUpdate(RECONNECT_ID, () => {});
      await connected(manager);
      fakeSockets[0]!.ev.emit('connection.update', close(401));

      expect(manager.ensureConnected(RECONNECT_ID, {})).toBe(false);
      await settle();
      expect(fakeSockets).toHaveLength(1);
    });

    it('leaves alone an account configured with retryOnDisconnect false', async () => {
      const manager = new BaileysSocketManager();
      manager.onConnectionUpdate(RECONNECT_ID, () => {});

      expect(manager.ensureConnected(RECONNECT_ID, { retryOnDisconnect: false })).toBe(false);
      await settle();
      expect(fakeSockets).toHaveLength(0);
    });

    it('allows an explicit connect after a logout (re-pairing)', async () => {
      const manager = new BaileysSocketManager();
      manager.onConnectionUpdate(RECONNECT_ID, () => {});
      await connected(manager);
      fakeSockets[0]!.ev.emit('connection.update', close(401));

      await manager.connect(RECONNECT_ID, {});
      await waitForSockets(2);

      expect(manager.hasSocket(RECONNECT_ID)).toBe(true);
    });
  });
});
