import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MessagingGatewayEvents } from '../src/events.js';

interface Conn { ws: ServerSocket; req: IncomingMessage }

let wss: WebSocketServer;
let conns: Conn[];
let waiters: Array<() => void>;
let client: MessagingGatewayEvents | undefined;
let baseUrl: string;

/** Resolves with the nth (0-based) server-side connection, once it exists. */
function connection(n: number): Promise<Conn> {
  if (conns[n]) return Promise.resolve(conns[n]);
  return new Promise((resolve) => {
    waiters.push(() => { if (conns[n]) resolve(conns[n]); });
  });
}

beforeEach(async () => {
  conns = [];
  waiters = [];
  wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  wss.on('connection', (ws, req) => {
    conns.push({ ws, req });
    for (const fn of [...waiters]) fn();
  });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  baseUrl = `http://127.0.0.1:${(wss.address() as AddressInfo).port}`;
});

afterEach(async () => {
  client?.disconnect();
  client = undefined;
  vi.useRealTimers();
  for (const c of wss.clients) c.terminate();
  await new Promise<void>((r) => wss.close(() => r()));
});

function next<T extends unknown[]>(register: (cb: (...a: T) => void) => void): Promise<T> {
  return new Promise((resolve) => register((...a) => resolve(a)));
}

/** Polls with setImmediate, which fake timers leave alone (unlike vi.waitFor). */
async function until(cond: () => boolean): Promise<void> {
  while (!cond()) await new Promise((r) => setImmediate(r));
}

describe('MessagingGatewayEvents auth', () => {
  it('sends Authorization header and no token query', async () => {
    client = new MessagingGatewayEvents({ baseUrl, apiKey: 'abc123', accounts: ['wa-1', 'wa-2'], autoReconnect: false });
    client.connect();

    const { req } = await connection(0);

    expect(req.headers.authorization).toBe('Bearer abc123');
    expect(req.url).not.toContain('token');
    expect(req.url).not.toContain('abc123');
    expect(req.url).toBe('/ws/events?accounts=wa-1%2Cwa-2');
  });

  it('connects without Authorization when no apiKey is set', async () => {
    client = new MessagingGatewayEvents({ baseUrl, autoReconnect: false });
    client.connect();
    const { req } = await connection(0);
    expect(req.headers.authorization).toBeUndefined();
    expect(req.url).toBe('/ws/events');
  });
});

describe('MessagingGatewayEvents events', () => {
  it('emits connected and message.inbound with accountSeq', async () => {
    client = new MessagingGatewayEvents({ baseUrl, apiKey: 'k', autoReconnect: false });
    const c = client;
    const connected = next((cb) => c.on('connected', cb));
    const inbound = next<[{ accountSeq?: number }]>((cb) => c.on('message.inbound', cb));
    client.connect();
    const { ws } = await connection(0);
    ws.send(JSON.stringify({ event: 'connected', timestamp: 't' }));
    ws.send(JSON.stringify({ event: 'message.inbound', data: { id: 'm1', accountSeq: 7 } }));

    await connected;
    const [env] = await inbound;
    expect(env.accountSeq).toBe(7);
  });
});

describe('MessagingGatewayEvents reconnect', () => {
  it('reconnects with growing delay', async () => {
    client = new MessagingGatewayEvents({
      baseUrl, apiKey: 'k', autoReconnect: true,
      reconnectBaseMs: 10, reconnectMaxMs: 1000, random: () => 1,
    });
    const delays: number[] = [];
    client.on('reconnecting', (_attempt, delayMs) => delays.push(delayMs));
    client.connect();

    for (let i = 0; i < 3; i++) {
      const { ws } = await connection(i);
      ws.close(); // server drops without ever sending `connected`
    }
    await connection(3);

    expect(delays.slice(0, 3)).toEqual([10, 20, 40]);
  });

  it('resets the attempt counter once the server confirms the connection', async () => {
    client = new MessagingGatewayEvents({
      baseUrl, apiKey: 'k', autoReconnect: true,
      reconnectBaseMs: 10, reconnectMaxMs: 1000, random: () => 1,
    });
    const c = client;
    const delays: number[] = [];
    client.on('reconnecting', (_a, d) => delays.push(d));
    client.connect();

    (await connection(0)).ws.close();
    const second = await connection(1);
    const connected = next((cb) => c.once('connected', cb));
    second.ws.send(JSON.stringify({ event: 'connected' }));
    await connected;
    second.ws.close();
    await connection(2);

    expect(delays).toEqual([10, 10]);
  });

  it('does not reconnect after disconnect()', async () => {
    client = new MessagingGatewayEvents({ baseUrl, apiKey: 'k', reconnectBaseMs: 5, random: () => 1 });
    const c = client;
    client.connect();
    await connection(0);
    const closed = next((cb) => c.on('disconnected', cb));
    client.disconnect();
    await closed;
    await new Promise((r) => setTimeout(r, 50));
    expect(conns).toHaveLength(1);
  });
});

describe('MessagingGatewayEvents heartbeat watchdog', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });

  it('terminates and reconnects when no ping for 75s', async () => {
    client = new MessagingGatewayEvents({ baseUrl, apiKey: 'k', autoReconnect: true, random: () => 1 });
    const c = client;
    client.connect();
    await connection(0);
    // let the client's `open` handler (which arms the watchdog) run
    await until(() => c.isConnected);

    const disconnected = next((cb) => c.on('disconnected', cb));
    const reconnecting = next<[number, number]>((cb) => c.on('reconnecting', cb));
    vi.advanceTimersByTime(74_999);
    expect(client.isConnected).toBe(true);
    vi.advanceTimersByTime(1);

    await disconnected;
    const [, delay] = await reconnecting;
    expect(delay).toBe(1000);
    vi.advanceTimersByTime(1000);
    await connection(1);
  });

  it('a server ping (or any message) re-arms the watchdog', async () => {
    client = new MessagingGatewayEvents({ baseUrl, apiKey: 'k', autoReconnect: false });
    const c = client;
    client.connect();
    const { ws } = await connection(0);
    await until(() => c.isConnected);

    vi.advanceTimersByTime(60_000);
    const pong = next((cb) => ws.once('pong', cb));
    ws.ping();
    await pong; // the client received the ping (ws auto-pongs)
    vi.advanceTimersByTime(60_000); // 120s since open, but only 60s since the ping
    expect(client.isConnected).toBe(true);

    const raw = next((cb) => c.once('raw', cb));
    ws.send(JSON.stringify({ event: 'pong' }));
    await raw;
    vi.advanceTimersByTime(74_000);
    expect(client.isConnected).toBe(true);

    const disconnected = next((cb) => c.on('disconnected', cb));
    vi.advanceTimersByTime(1000);
    await disconnected;
    expect(client.isConnected).toBe(false);
  });
});
