import { EventEmitter } from 'node:events';
import { computeBackoffMs, DEFAULT_BACKOFF_BASE_MS, DEFAULT_BACKOFF_MAX_MS } from './backoff.js';
import { openSocket, DEFAULT_HANDSHAKE_TIMEOUT_MS, type GatewaySocket } from './socket.js';
import type {
  EventsConfig, SendMessageCommand, UnifiedEnvelope,
  MessageSentData, ConnectionUpdateData, MessageSendFailedData,
  WsEventType,
} from './types.js';

type EventMap = {
  'connected': [];
  'disconnected': [code: number, reason: string];
  'error': [error: Error];
  'message.inbound': [envelope: UnifiedEnvelope];
  'message.sent': [data: MessageSentData];
  'message.send.failed': [data: MessageSendFailedData];
  'connection.update': [data: ConnectionUpdateData];
  'subscribed': [accounts: string[]];
  'unsubscribed': [accounts: string[]];
  'pong': [];
  /** A reconnect was scheduled: `attempt` is 1-based, `delayMs` the jittered wait. */
  'reconnecting': [attempt: number, delayMs: number];
  'raw': [event: WsEventType, data: unknown];
};

interface ServerMessage { event: string; timestamp?: string; data?: unknown; accounts?: string[]; replyTo?: string }

/** No server ping and no message for this long means the connection is dead (the server pings every 30 s). */
const HEARTBEAT_TIMEOUT_MS = 75_000;

/**
 * WebSocket event client for real-time gateway events.
 *
 * Authenticates with the API key in an `Authorization` header (Node) or the
 * `umg.<key>` subprotocol (browser) — never in the URL. Reconnects with
 * exponential backoff and full jitter, and drops connections that go silent
 * for 75 s. After a reconnect, use `client.messages.after(...)` with the last
 * seen `accountSeq` to catch up on anything missed.
 *
 * @example
 * ```typescript
 * const events = new MessagingGatewayEvents({
 *   baseUrl: 'http://localhost:3123',
 *   apiKey: 'your-key',
 *   accounts: ['wa-1'],
 * });
 *
 * events.on('message.inbound', (envelope) => {
 *   console.log(`${envelope.sender.displayName}: ${envelope.content.type}`);
 * });
 *
 * events.connect();
 * ```
 */
export class MessagingGatewayEvents {
  private ws: GatewaySocket | null = null;
  private readonly config: Required<Omit<EventsConfig, 'reconnectIntervalMs'>>;
  private readonly emitter = new EventEmitter();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private intentionalClose = false;
  private pendingSends: Array<{ resolve: (id: string) => void; reject: (err: Error) => void; id: string }> = [];

  constructor(config: EventsConfig) {
    this.config = {
      baseUrl: config.baseUrl.replace(/\/$/, ''),
      apiKey: config.apiKey ?? '',
      accounts: config.accounts ?? [],
      autoReconnect: config.autoReconnect ?? true,
      reconnectBaseMs: config.reconnectBaseMs ?? config.reconnectIntervalMs ?? DEFAULT_BACKOFF_BASE_MS,
      reconnectMaxMs: config.reconnectMaxMs ?? DEFAULT_BACKOFF_MAX_MS,
      handshakeTimeoutMs: config.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      random: config.random ?? Math.random,
    };
  }

  /** Connect to the WebSocket server */
  connect(): void {
    if (this.ws) return; // already open or connecting

    this.intentionalClose = false;
    const socket: GatewaySocket = openSocket(this.buildWsUrl(), this.config.apiKey, {
      onOpen: () => {
        // 'connected' event comes from the server, not from the open event
        if (this.ws === socket) this.armWatchdog();
      },
      onMessage: (data) => {
        if (this.ws === socket) this.armWatchdog();
        let msg: ServerMessage;
        try {
          msg = JSON.parse(data);
        } catch {
          return; // Ignore malformed messages
        }
        this.handleServerMessage(msg);
      },
      onPing: () => {
        if (this.ws === socket) this.armWatchdog();
      },
      onClose: (code, reason) => {
        const wasCurrent = this.ws === socket;
        if (wasCurrent) {
          this.ws = null;
          this.clearWatchdog();
        }
        // Schedule the reconnect before notifying anyone: nothing a listener does may prevent it
        if (wasCurrent && this.config.autoReconnect && !this.intentionalClose) {
          this.scheduleReconnect();
        }
        this.rejectPendingSends('WebSocket disconnected');
        this.emit('disconnected', code, reason);
      },
      onError: (err) => {
        // Errors from a socket we already dropped (e.g. an aborted handshake) are noise,
        // and an EventEmitter 'error' nobody listens to would throw
        if (this.ws === socket && this.emitter.listenerCount('error') > 0) {
          this.emit('error', err);
        }
      },
    }, undefined, this.config.handshakeTimeoutMs);
    this.ws = socket;
    // Also bound the connecting phase: an upgrade that never completes must not wedge the client
    this.armWatchdog();
  }

  /** Disconnect from the WebSocket server */
  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearWatchdog();
    const socket = this.ws;
    this.ws = null;
    socket?.close(1000, 'Client disconnect');
    this.rejectPendingSends('Client disconnected');
  }

  /** Subscribe to events from specific accounts */
  subscribe(accounts: string[]): void {
    this.sendAction({ action: 'subscribe', accounts });
  }

  /** Unsubscribe from account events */
  unsubscribe(accounts: string[]): void {
    this.sendAction({ action: 'unsubscribe', accounts });
  }

  /** Send a message via WebSocket (returns correlation ID) */
  async send(command: SendMessageCommand): Promise<string> {
    const id = `sdk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.sendAction({ action: 'send', id, data: command });
    return id;
  }

  /** Ping the server */
  ping(): void {
    this.sendAction({ action: 'ping' });
  }

  /** Whether the WebSocket is connected */
  get isConnected(): boolean {
    return this.ws?.isOpen ?? false;
  }

  // ── Event listener methods ──────────────────────────────────

  on<K extends keyof EventMap>(event: K, listener: (...args: EventMap[K]) => void): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  once<K extends keyof EventMap>(event: K, listener: (...args: EventMap[K]) => void): this {
    this.emitter.once(event, listener as (...args: unknown[]) => void);
    return this;
  }

  off<K extends keyof EventMap>(event: K, listener: (...args: EventMap[K]) => void): this {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
    return this;
  }

  // ── Internal ────────────────────────────────────────────────

  private handleServerMessage(msg: ServerMessage): void {
    const event = msg.event as WsEventType;

    // Emit raw for advanced consumers
    this.emit('raw', event, msg.data);

    switch (event) {
      case 'connected':
        // The server accepted us: the connection is healthy, so backoff starts over
        this.reconnectAttempt = 0;
        this.emit('connected');
        break;
      case 'message.inbound':
        this.emit('message.inbound', msg.data as UnifiedEnvelope);
        break;
      case 'message.sent':
        this.emit('message.sent', msg.data as MessageSentData);
        break;
      case 'message.send.failed':
        this.emit('message.send.failed', msg.data as MessageSendFailedData);
        break;
      case 'connection.update':
        this.emit('connection.update', msg.data as ConnectionUpdateData);
        break;
      case 'subscribed':
        this.emit('subscribed', msg.accounts ?? []);
        break;
      case 'unsubscribed':
        this.emit('unsubscribed', msg.accounts ?? []);
        break;
      case 'pong':
        this.emit('pong');
        break;
    }
  }

  private sendAction(action: Record<string, unknown>): void {
    if (!this.ws?.isOpen) {
      throw new Error('WebSocket is not connected');
    }
    this.ws.send(JSON.stringify(action));
  }

  /** The API key is deliberately not part of the URL; see `openSocket`. */
  private buildWsUrl(): string {
    const base = this.config.baseUrl
      .replace(/^http:/, 'ws:')
      .replace(/^https:/, 'wss:');

    const params = new URLSearchParams();
    if (this.config.accounts.length) params.set('accounts', this.config.accounts.join(','));

    const qs = params.toString();
    return `${base}/ws/events${qs ? `?${qs}` : ''}`;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delayMs = computeBackoffMs(this.reconnectAttempt, {
      baseMs: this.config.reconnectBaseMs,
      maxMs: this.config.reconnectMaxMs,
      random: this.config.random,
    });
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
    this.emit('reconnecting', this.reconnectAttempt, delayMs);
  }

  /**
   * Emits to every listener in isolation: one that throws neither aborts the socket
   * handlers nor starves the remaining listeners. The exception is reported through
   * the `error` event instead of being swallowed.
   */
  private emit<K extends keyof EventMap>(event: K, ...args: EventMap[K]): void {
    for (const listener of this.emitter.rawListeners(event)) {
      try {
        (listener as (...a: unknown[]) => void)(...args);
      } catch (err) {
        this.reportListenerError(event, err);
      }
    }
  }

  private reportListenerError(event: keyof EventMap, err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err));
    if (event !== 'error' && this.emitter.listenerCount('error') > 0) {
      this.emit('error', error);
      return;
    }
    // A throwing 'error' listener, or nobody listening: do not crash the socket loop, do not hide it
    console.error(`[messaging-gateway-sdk] unhandled error in '${event}' listener:`, error);
  }

  /** (Re)starts the dead-connection timer; any server activity proves the link is alive. */
  private armWatchdog(): void {
    if (!this.ws?.supportsPing) return;
    this.clearWatchdog();
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = null;
      // terminate() makes the socket's close handler run, which schedules the reconnect
      this.ws?.terminate();
    }, HEARTBEAT_TIMEOUT_MS);
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private rejectPendingSends(reason: string): void {
    for (const pending of this.pendingSends) {
      pending.reject(new Error(reason));
    }
    this.pendingSends = [];
  }
}
