/**
 * WebSocket endpoint: header / subprotocol auth, read-only clients, and the server-side
 * heartbeat that terminates dead (half-open) clients so consumers reconnect and catch up.
 */
import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { EventBus } from '../../src/core/event-bus.js';
import { Events, createEvent } from '../../src/core/events.js';
import type { ConnectionUpdatePayload } from '../../src/core/events.js';
import { WebSocketBroadcaster } from '../../src/connections/ws/websocket-broadcaster.js';
import { buildTestServer, createLogCapture, ADMIN_KEY, READ_KEY } from './helpers/test-server.js';

const HEARTBEAT_MS = 30_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let app: FastifyInstance;
let bus: EventBus;
let broadcaster: WebSocketBroadcaster;
let baseUrl: string;
const opened: WebSocket[] = [];

async function startServer(overrides: Record<string, unknown> = {}): Promise<void> {
  bus = new EventBus();
  broadcaster = new WebSocketBroadcaster(bus);
  app = await buildTestServer({ wsBroadcaster: broadcaster, ...overrides });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  baseUrl = `ws://127.0.0.1:${addr.port}/ws/events`;
}

/** Opens a socket and collects every JSON message it receives. */
function connect(url: string, protocols?: string[], options: WebSocket.ClientOptions = {}) {
  const socket = new WebSocket(url, protocols, options);
  opened.push(socket);
  const messages: Record<string, any>[] = [];
  socket.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  const ready = new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  const closed = new Promise<{ code: number }>((resolve) => {
    socket.once('close', (code) => resolve({ code }));
  });
  return { socket, messages, ready, closed };
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 2000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await sleep(10);
  }
}

function emitConnectionUpdate(qr?: string) {
  return bus.emit(
    createEvent<ConnectionUpdatePayload>(
      Events.CONNECTION_UPDATE,
      'test',
      { accountId: 'wa-test', status: 'connecting', ...(qr ? { qr } : {}) },
      'wa-test',
    ),
  );
}

afterEach(async () => {
  vi.useRealTimers();
  for (const s of opened.splice(0)) s.terminate();
  await app?.close();
});

describe('ws authentication', () => {
  beforeEach(async () => {
    await startServer();
  });

  it('ws accepts Authorization header', async () => {
    const c = connect(baseUrl, undefined, { headers: { Authorization: `Bearer ${ADMIN_KEY}` } });
    await c.ready;
    await waitFor(() => c.messages.find((m) => m['event'] === 'connected'));
  });

  it('ws accepts x-api-key header', async () => {
    const c = connect(baseUrl, undefined, { headers: { 'x-api-key': READ_KEY } });
    await c.ready;
    await waitFor(() => c.messages.find((m) => m['event'] === 'connected'));
  });

  it('ws accepts umg.<key> subprotocol and echoes it back', async () => {
    const c = connect(baseUrl, [`umg.${ADMIN_KEY}`]);
    await c.ready;
    expect(c.socket.protocol).toBe(`umg.${ADMIN_KEY}`);
    await waitFor(() => c.messages.find((m) => m['event'] === 'connected'));
  });

  it('still accepts ?token= (deprecated)', async () => {
    const c = connect(`${baseUrl}?token=${ADMIN_KEY}`);
    await c.ready;
    await waitFor(() => c.messages.find((m) => m['event'] === 'connected'));
  });

  it('closes 4401 without credentials', async () => {
    const c = connect(baseUrl);
    await c.ready;
    expect((await c.closed).code).toBe(4401);
  });

  it('closes 4401 with a wrong subprotocol key', async () => {
    const c = connect(baseUrl, ['umg.wrong-key']);
    await c.ready;
    expect((await c.closed).code).toBe(4401);
  });
});

describe('ws read-only client', () => {
  beforeEach(async () => {
    await startServer();
  });

  it('ws read client never receives qr, admin client does', async () => {
    const reader = connect(baseUrl, [`umg.${READ_KEY}`]);
    const admin = connect(baseUrl, [`umg.${ADMIN_KEY}`]);
    await Promise.all([reader.ready, admin.ready]);
    await waitFor(() => reader.messages.find((m) => m['event'] === 'connected'));
    await waitFor(() => admin.messages.find((m) => m['event'] === 'connected'));

    await emitConnectionUpdate('QR-PAYLOAD-123');

    const forReader = await waitFor(() => reader.messages.find((m) => m['event'] === 'connection.update'));
    const forAdmin = await waitFor(() => admin.messages.find((m) => m['event'] === 'connection.update'));
    expect(forReader['data'].qr).toBeNull();
    expect(JSON.stringify(reader.messages)).not.toContain('QR-PAYLOAD-123');
    expect(forAdmin['data'].qr).toBe('QR-PAYLOAD-123');
  });

  it('refuses the send action for a read client', async () => {
    const sendRequests: unknown[] = [];
    bus.on(Events.MESSAGE_SEND_REQUEST, (e) => {
      sendRequests.push(e);
    });
    const reader = connect(baseUrl, [`umg.${READ_KEY}`]);
    await reader.ready;
    await waitFor(() => reader.messages.find((m) => m['event'] === 'connected'));

    reader.socket.send(JSON.stringify({
      action: 'send',
      id: 'corr-1',
      data: { to: '+34600000000', content: { type: 'text', body: 'hi' } },
    }));

    const refusal = await waitFor(() => reader.messages.find((m) => m['event'] === 'message.send.failed'));
    expect(refusal['replyTo']).toBe('corr-1');
    expect(String(refusal['data'].error)).toMatch(/read-only/i);
    await sleep(30);
    expect(sendRequests).toHaveLength(0);
  });

  it('lets an admin client send', async () => {
    const sendRequests: unknown[] = [];
    bus.on(Events.MESSAGE_SEND_REQUEST, (e) => {
      sendRequests.push(e);
    });
    const admin = connect(baseUrl, [`umg.${ADMIN_KEY}`]);
    await admin.ready;
    await waitFor(() => admin.messages.find((m) => m['event'] === 'connected'));

    admin.socket.send(JSON.stringify({
      action: 'send',
      data: { to: '+34600000000', content: { type: 'text', body: 'hi' } },
    }));

    await waitFor(() => (sendRequests.length ? true : undefined));
  });
});

describe('ws heartbeat', () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await startServer();
  });

  it('server terminates client that does not answer ping within one interval', async () => {
    const c = connect(baseUrl, [`umg.${ADMIN_KEY}`], { autoPong: false });
    await c.ready;
    await waitFor(() => c.messages.find((m) => m['event'] === 'connected'));
    expect(broadcaster.clientCount).toBe(1);

    vi.advanceTimersByTime(HEARTBEAT_MS); // first tick: ping goes out
    await sleep(50);
    expect(c.socket.readyState).toBe(WebSocket.OPEN);

    vi.advanceTimersByTime(HEARTBEAT_MS); // second tick: no pong since the last one -> terminate
    const { code } = await c.closed;

    expect(code).toBe(1006);
    await waitFor(() => (broadcaster.clientCount === 0 ? true : undefined));
  });

  it('keeps a client that answers pings', async () => {
    const c = connect(baseUrl, [`umg.${ADMIN_KEY}`]);
    await c.ready;
    await waitFor(() => c.messages.find((m) => m['event'] === 'connected'));

    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(HEARTBEAT_MS);
      await sleep(50); // let the ping/pong round trip happen on the real event loop
    }

    expect(c.socket.readyState).toBe(WebSocket.OPEN);
    expect(broadcaster.clientCount).toBe(1);
  });
});

describe('broadcaster send failures', () => {
  function fakeSocket(failing: 'throw' | 'callback') {
    const socket = new EventEmitter() as EventEmitter & Record<string, any>;
    socket.readyState = 1;
    let sends = 0;
    socket.send = vi.fn((_data: string, cb?: (err?: Error) => void) => {
      sends += 1;
      if (sends === 1) return cb?.(); // the "connected" greeting goes through
      if (failing === 'throw') throw new Error('socket is gone');
      cb?.(new Error('write failed'));
    });
    socket.ping = vi.fn();
    socket.terminate = vi.fn();
    return socket;
  }

  it.each(['throw', 'callback'] as const)('terminates a client whose send fails (%s)', async (mode) => {
    const eventBus = new EventBus();
    const b = new WebSocketBroadcaster(eventBus);
    const socket = fakeSocket(mode);
    b.addClient(socket as any, undefined, 'admin');

    await emitOn(eventBus);

    expect(socket.terminate).toHaveBeenCalledTimes(1);
    expect(b.clientCount).toBe(0);
  });

  async function emitOn(eventBus: EventBus) {
    await eventBus.emit(
      createEvent<ConnectionUpdatePayload>(Events.CONNECTION_UPDATE, 'test', { accountId: 'a', status: 'connected' }, 'a'),
    );
  }
});

describe('logs of the ws upgrade', () => {
  it('never contain the ?token= value', async () => {
    const logs = createLogCapture();
    await startServer({ logLevel: 'info', logStream: logs.stream });
    const secret = 'WS-LEAK-CHECK-TOKEN';

    const c = connect(`${baseUrl}?token=${secret}`);
    await c.ready;
    await c.closed; // wrong token: closed with 4401, after the upgrade request was handled
    await app.close();

    expect(logs.text()).not.toContain(secret);
  });
});
