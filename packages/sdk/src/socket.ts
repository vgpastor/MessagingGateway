import WebSocket from 'ws';

/** Callbacks a transport reports to the events client. */
export interface SocketHandlers {
  onOpen(): void;
  onMessage(data: string): void;
  /** Server ping frame received. Only fired where the runtime exposes ping frames (Node). */
  onPing(): void;
  onClose(code: number, reason: string): void;
  onError(error: Error): void;
}

/** Minimal runtime-independent view of a WebSocket. */
export interface GatewaySocket {
  readonly isOpen: boolean;
  /** Whether ping frames are observable (and so a heartbeat watchdog is meaningful). */
  readonly supportsPing: boolean;
  send(data: string): void;
  close(code: number, reason: string): void;
  /** Drop the connection without a closing handshake. */
  terminate(): void;
}

export interface SocketEnv {
  isNode: boolean;
  /** Browser-style `WebSocket` constructor (no custom headers). */
  BrowserWebSocket?: typeof globalThis.WebSocket;
}

const OPEN = 1;

/** Max time for the HTTP upgrade to complete before the attempt is abandoned. */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;

function detectEnv(): SocketEnv {
  const isNode = typeof process !== 'undefined' && !!process.versions?.node;
  return { isNode, BrowserWebSocket: (globalThis as { WebSocket?: typeof globalThis.WebSocket }).WebSocket };
}

/**
 * Opens an authenticated WebSocket.
 *
 * - Node: the `ws` library, key sent as `Authorization: Bearer <key>`.
 * - Browser (no way to set headers): key sent as the `umg.<key>` subprotocol.
 *
 * The key never goes in the URL (it would end up in proxy/access logs).
 */
export function openSocket(
  url: string, apiKey: string, handlers: SocketHandlers,
  env: SocketEnv = detectEnv(), handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
): GatewaySocket {
  return env.isNode ? openNodeSocket(url, apiKey, handlers, handshakeTimeoutMs) : openBrowserSocket(url, apiKey, handlers, env);
}

function openNodeSocket(url: string, apiKey: string, h: SocketHandlers, handshakeTimeout: number): GatewaySocket {
  const ws = new WebSocket(url, {
    handshakeTimeout,
    ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
  });
  ws.on('open', () => h.onOpen());
  ws.on('message', (raw: Buffer | string) => h.onMessage(raw.toString()));
  ws.on('ping', () => h.onPing());
  ws.on('close', (code, reason) => h.onClose(code, reason.toString()));
  ws.on('error', (err) => h.onError(err));
  return {
    get isOpen() { return ws.readyState === WebSocket.OPEN; },
    supportsPing: true,
    send: (data) => ws.send(data),
    close: (code, reason) => {
      // close() while still CONNECTING aborts the handshake (an `error` follows); terminate() is the clean equivalent
      if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
      else ws.close(code, reason);
    },
    terminate: () => ws.terminate(),
  };
}

function openBrowserSocket(url: string, apiKey: string, h: SocketHandlers, env: SocketEnv): GatewaySocket {
  const Ctor = env.BrowserWebSocket;
  if (!Ctor) throw new Error('No WebSocket implementation available in this runtime');
  const ws = apiKey ? new Ctor(url, [`umg.${apiKey}`]) : new Ctor(url);
  ws.addEventListener('open', () => h.onOpen());
  ws.addEventListener('message', (ev) => h.onMessage(String((ev as MessageEvent).data)));
  ws.addEventListener('close', (ev) => h.onClose((ev as CloseEvent).code, (ev as CloseEvent).reason));
  ws.addEventListener('error', () => h.onError(new Error('WebSocket error')));
  return {
    get isOpen() { return ws.readyState === OPEN; },
    // Browsers answer pings natively and never surface them, so a silence-based watchdog would misfire
    supportsPing: false,
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    terminate: () => ws.close(),
  };
}
