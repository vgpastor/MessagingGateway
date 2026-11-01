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
const auth = { saveCreds: (): unknown => undefined, failLoad: false };
let versionFetches = 0;

vi.mock('@whiskeysockets/baileys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@whiskeysockets/baileys')>()),
  default: () => {
    const socket: FakeSocket = { ev: new EventEmitter(), end: () => {}, logout: async () => {} };
    fakeSockets.push(socket);
    return socket;
  },
  useMultiFileAuthState: async () => {
    if (auth.failLoad) throw new Error('cannot read the auth state');
    return { state: {}, saveCreds: () => auth.saveCreds() };
  },
  fetchLatestBaileysVersion: async () => {
    versionFetches += 1;
    return { version: [2, 3000, 1] };
  },
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
    await mkdir(closeAuthDir, { recursive: true });
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

describe('BaileysSocketManager.closeConnection', () => {
  const ID = 'test-close-one';
  const OTHER = 'test-close-other';
  const authDirOf = (id: string) => resolve(process.cwd(), 'data', 'baileys-auth', id);

  afterEach(async () => {
    vi.useRealTimers();
    fakeSockets.length = 0;
    await rm(authDirOf(ID), { recursive: true, force: true });
    await rm(authDirOf(OTHER), { recursive: true, force: true });
  });

  it('closes that socket without logging out and keeps the session on disk; the other accounts are not touched', async () => {
    const manager = new BaileysSocketManager();
    await manager.connect(OTHER, {});
    const other = vi.spyOn(fakeSockets.at(-1)!, 'end');
    await manager.connect(ID, {});
    const socket = fakeSockets.at(-1)!;
    const end = vi.spyOn(socket, 'end');
    const logout = vi.spyOn(socket, 'logout');
    await mkdir(authDirOf(ID), { recursive: true });
    await writeFile(resolve(authDirOf(ID), 'creds.json'), '{}');

    manager.closeConnection(ID);

    expect(end).toHaveBeenCalledTimes(1);
    expect(logout).not.toHaveBeenCalled();
    expect(existsSync(resolve(authDirOf(ID), 'creds.json'))).toBe(true);
    expect(manager.hasSocket(ID)).toBe(false);
    expect(other).not.toHaveBeenCalled();
    expect(manager.hasSocket(OTHER)).toBe(true);
  });

  it('tells the subscribers it was on purpose, so nobody takes it for an outage', async () => {
    const manager = new BaileysSocketManager();
    const seen: unknown[] = [];
    manager.onConnectionUpdate(ID, (update) => seen.push([update.connection, manager.getConnectionEnd(ID)]));
    await manager.connect(ID, {});

    manager.closeConnection(ID);

    expect(seen).toEqual([['close', 'closed']]);
  });

  it('does not reconnect: not from the close event, a timer already scheduled or the health checker', async () => {
    vi.useFakeTimers();
    const manager = new BaileysSocketManager({ random: () => 0.5 });
    manager.onMessage(ID, () => {});
    await manager.connect(ID, {});
    const socket = fakeSockets.at(-1)!;
    const before = fakeSockets.length;
    socket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: new Error('blip') } });

    manager.closeConnection(ID);
    socket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: new Error('closed') } });
    await vi.advanceTimersByTimeAsync(600_000);

    expect(manager.ensureConnected(ID, {})).toBe(false);
    expect(fakeSockets.length).toBe(before);
  });

  it('does not open the socket of a connect that was already in flight', async () => {
    const manager = new BaileysSocketManager();
    const before = fakeSockets.length;

    const connecting = manager.connect(ID, {});
    manager.closeConnection(ID);
    await connecting;

    expect(fakeSockets.length).toBe(before);
    expect(manager.hasSocket(ID)).toBe(false);
  });

  it('an explicit connect opens it again, and the messages reach the same subscribers', async () => {
    const manager = new BaileysSocketManager();
    const onMessage = vi.fn();
    manager.onMessage(ID, onMessage);
    await manager.connect(ID, {});
    manager.closeConnection(ID);

    await manager.connect(ID, {});
    fakeSockets.at(-1)!.ev.emit('messages.upsert', { messages: [], type: 'notify' });

    expect(manager.hasSocket(ID)).toBe(true);
    expect(manager.getConnectionEnd(ID)).toBeUndefined();
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it('an explicit connect while the closed one is still in flight wins: the account does not stay down', async () => {
    const manager = new BaileysSocketManager();

    const first = manager.connect(ID, {});
    manager.closeConnection(ID);
    await manager.connect(ID, {});
    await first;

    expect(manager.hasSocket(ID)).toBe(true);
    expect(manager.getConnectionEnd(ID)).toBeUndefined();
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

  it('tells the subscribers that a disconnect was on purpose, before forgetting them', async () => {
    const manager = new BaileysSocketManager();
    const seen: unknown[] = [];
    manager.onConnectionUpdate('gone-2', () => seen.push(manager.getConnectionEnd('gone-2')));

    await manager.disconnect('gone-2');

    expect(seen).toEqual(['closed']);
  });
});

describe('BaileysSocketManager.requestPairingCode', () => {
  const PAIR_ID = 'test-pair';
  const pairAuthDir = resolve(process.cwd(), 'data', 'baileys-auth', PAIR_ID);

  afterEach(async () => {
    vi.useRealTimers();
    fakeSockets.length = 0;
    await rm(pairAuthDir, { recursive: true, force: true });
  });

  async function open(manager: BaileysSocketManager) {
    await manager.connect(PAIR_ID, {});
    const socket = fakeSockets.at(-1)! as FakeSocket & { requestPairingCode: ReturnType<typeof vi.fn> };
    socket.requestPairingCode = vi.fn(async () => 'CODE');
    return socket;
  }

  it('waits for the first QR, the sign that the handshake is done, before asking', async () => {
    const manager = new BaileysSocketManager();
    const socket = await open(manager);

    const code = manager.requestPairingCode(PAIR_ID, '+34 600');
    await Promise.resolve();
    expect(socket.requestPairingCode).not.toHaveBeenCalled();

    socket.ev.emit('connection.update', { qr: 'QR' });

    expect(await code).toBe('CODE');
    expect(socket.requestPairingCode).toHaveBeenCalledWith('34600');
    expect(socket.ev.listenerCount('connection.update')).toBe(1);
  });

  it('asks right away when the QR is already there', async () => {
    const manager = new BaileysSocketManager();
    const socket = await open(manager);
    socket.ev.emit('connection.update', { qr: 'QR' });

    expect(await manager.requestPairingCode(PAIR_ID, '34600')).toBe('CODE');
  });

  it('gives up after its limit when the handshake never ends', async () => {
    const manager = new BaileysSocketManager();
    const socket = await open(manager);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const code = manager.requestPairingCode(PAIR_ID, '34600');
    const failed = expect(code).rejects.toThrow(/not ready/);
    await vi.advanceTimersByTimeAsync(15_000);

    await failed;
    expect(socket.requestPairingCode).not.toHaveBeenCalled();
    expect(socket.ev.listenerCount('connection.update')).toBe(1);
  });

  it('a session that opens while it waits needed no pairing', async () => {
    const manager = new BaileysSocketManager();
    const socket = await open(manager);

    const code = manager.requestPairingCode(PAIR_ID, '34600');
    socket.ev.emit('connection.update', { connection: 'open' });

    await expect(code).rejects.toThrow(/already connected/);
    expect(socket.requestPairingCode).not.toHaveBeenCalled();
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
    auth.failLoad = false;
    await rm(reconnectAuthDir, { recursive: true, force: true });
  });

  function useFakeTimeouts(): void {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
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

  it('does not serve the QR of a closed connection, while it waits nor on the socket that replaces it', async () => {
    useFakeTimeouts();
    const manager = new BaileysSocketManager({ random: maxJitter });
    await connected(manager);
    fakeSockets[0]!.ev.emit('connection.update', { qr: 'OLD-QR' });
    expect(manager.getLastQr(RECONNECT_ID)).toBe('OLD-QR');

    fakeSockets[0]!.ev.emit('connection.update', close(428));
    expect(manager.hasSocket(RECONNECT_ID)).toBe(true);
    expect(manager.getLastQr(RECONNECT_ID)).toBeUndefined();

    await vi.advanceTimersByTimeAsync(60_000);
    await waitForSockets(2);
    expect(manager.getLastQr(RECONNECT_ID)).toBeUndefined();

    fakeSockets[1]!.ev.emit('connection.update', { qr: 'NEW-QR' });
    expect(manager.getLastQr(RECONNECT_ID)).toBe('NEW-QR');
  });

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

  /** Three failures in a row, leaving the fourth socket open. The next close waits 8 s unless the streak was forgotten. */
  async function openAfterThreeFailures(manager: BaileysSocketManager): Promise<void> {
    await connected(manager);
    for (let i = 0; i < 3; i++) {
      fakeSockets[i]!.ev.emit('connection.update', close(428));
      await vi.advanceTimersByTimeAsync(300_000);
      await waitForSockets(i + 2);
    }
    fakeSockets[3]!.ev.emit('connection.update', { connection: 'open' });
  }

  it('forgets the failure streak once the connection has been stable for 60 s', async () => {
    useFakeTimeouts();
    const manager = new BaileysSocketManager({ random: maxJitter });
    await openAfterThreeFailures(manager);
    await vi.advanceTimersByTimeAsync(60_000);

    fakeSockets[3]!.ev.emit('connection.update', close(428));
    await vi.advanceTimersByTimeAsync(1000);
    await waitForSockets(5);
  });

  it('keeps backing off when the connection opens and drops right away (no reconnection storm)', async () => {
    useFakeTimeouts();
    const manager = new BaileysSocketManager({ random: maxJitter });
    await openAfterThreeFailures(manager);
    await vi.advanceTimersByTimeAsync(59_999);

    fakeSockets[3]!.ev.emit('connection.update', close(428));
    await vi.advanceTimersByTimeAsync(7_999);
    await settle();
    expect(fakeSockets).toHaveLength(4);

    await vi.advanceTimersByTimeAsync(1);
    await waitForSockets(5);
  });

  it('waits at least 5 minutes after a 440: another session took over and insisting only kicks it out', async () => {
    useFakeTimeouts();
    const manager = new BaileysSocketManager({ random: () => 0 });
    await connected(manager);

    fakeSockets[0]!.ev.emit('connection.update', close(440));
    await vi.advanceTimersByTimeAsync(299_999);
    await settle();
    expect(fakeSockets).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    await waitForSockets(2);
  });

  it('a 403 is terminal, like a 401: the session is lost and only an explicit connect revives it', async () => {
    useFakeTimeouts();
    const manager = new BaileysSocketManager({ random: maxJitter });
    manager.onConnectionUpdate(RECONNECT_ID, () => {});
    await connected(manager);

    fakeSockets[0]!.ev.emit('connection.update', close(403));
    await vi.advanceTimersByTimeAsync(600_000);
    await settle();

    expect(fakeSockets).toHaveLength(1);
    expect(manager.hasSocket(RECONNECT_ID)).toBe(false);
    expect(manager.getConnectionEnd(RECONNECT_ID)).toBe('session_lost');
    expect(manager.ensureConnected(RECONNECT_ID, {})).toBe(false);
  });

  it('asks for the WhatsApp version again after a 405, and only then', async () => {
    useFakeTimeouts();
    const manager = new BaileysSocketManager({ random: maxJitter });
    await connected(manager);
    const fetches = versionFetches;

    fakeSockets[0]!.ev.emit('connection.update', close(428));
    await vi.advanceTimersByTimeAsync(300_000);
    await waitForSockets(2);
    expect(versionFetches).toBe(fetches);

    fakeSockets[1]!.ev.emit('connection.update', close(405));
    await vi.advanceTimersByTimeAsync(300_000);
    await waitForSockets(3);
    expect(versionFetches).toBe(fetches + 1);
  });

  it('reports a connect that could not even open, which no socket event would ever tell', async () => {
    const manager = new BaileysSocketManager();
    const handler = vi.fn();
    manager.onConnectionUpdate(RECONNECT_ID, handler);
    auth.failLoad = true;

    await expect(manager.connect(RECONNECT_ID, {})).rejects.toThrow('cannot read the auth state');

    expect(handler).toHaveBeenCalledWith({ connection: 'close' });
  });

  it('does not open the socket of a connect in flight when the account is disconnected meanwhile', async () => {
    const manager = new BaileysSocketManager();

    const connecting = manager.connect(RECONNECT_ID, {});
    await manager.disconnect(RECONNECT_ID);
    await connecting;

    expect(fakeSockets).toHaveLength(0);
    expect(manager.hasSocket(RECONNECT_ID)).toBe(false);
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
