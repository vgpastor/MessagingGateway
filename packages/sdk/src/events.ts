import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
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
  'raw': [event: WsEventType, data: unknown];
};

/**
 * WebSocket event client for real-time gateway events.
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
  private ws: WebSocket | null = null;
  private readonly config: Required<EventsConfig>;
  private readonly emitter = new EventEmitter();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private pendingSends: Array<{ resolve: (id: string) => void; reject: (err: Error) => void; id: string }> = [];

  constructor(config: EventsConfig) {
    this.config = {
      baseUrl: config.baseUrl.replace(/\/$/, ''),
      apiKey: config.apiKey ?? '',
      accounts: config.accounts ?? [],
      autoReconnect: config.autoReconnect ?? true,
      reconnectIntervalMs: config.reconnectIntervalMs ?? 5000,
    };
  }

  /** Connect to the WebSocket server */
  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    this.intentionalClose = false;
    const wsUrl = this.buildWsUrl();
    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      // 'connected' event comes from the server, not from the open event
    });

    this.ws.on('message', (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(raw.toString());
        this.handleServerMessage(msg);
      } catch {
        // Ignore malformed messages
      }
    });

    this.ws.on('close', (code, reason) => {
      this.ws = null;
      this.emitter.emit('disconnected', code, reason.toString());
      this.rejectPendingSends('WebSocket disconnected');

      if (this.config.autoReconnect && !this.intentionalClose) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err) => {
      this.emitter.emit('error', err);
    });
  }

  /** Disconnect from the WebSocket server */
  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
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
    return this.ws?.readyState === WebSocket.OPEN;
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

  private handleServerMessage(msg: { event: string; timestamp?: string; data?: unknown; accounts?: string[]; replyTo?: string }): void {
    const event = msg.event as WsEventType;

    // Emit raw for advanced consumers
    this.emitter.emit('raw', event, msg.data);

    switch (event) {
      case 'connected':
        this.emitter.emit('connected');
        break;
      case 'message.inbound':
        this.emitter.emit('message.inbound', msg.data as UnifiedEnvelope);
        break;
      case 'message.sent':
        this.emitter.emit('message.sent', msg.data as MessageSentData);
        break;
      case 'message.send.failed':
        this.emitter.emit('message.send.failed', msg.data as MessageSendFailedData);
        break;
      case 'connection.update':
        this.emitter.emit('connection.update', msg.data as ConnectionUpdateData);
        break;
      case 'subscribed':
        this.emitter.emit('subscribed', msg.accounts ?? []);
        break;
      case 'unsubscribed':
        this.emitter.emit('unsubscribed', msg.accounts ?? []);
        break;
      case 'pong':
        this.emitter.emit('pong');
        break;
    }
  }

  private sendAction(action: Record<string, unknown>): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }
    this.ws.send(JSON.stringify(action));
  }

  private buildWsUrl(): string {
    const base = this.config.baseUrl
      .replace(/^http:/, 'ws:')
      .replace(/^https:/, 'wss:');

    const params = new URLSearchParams();
    if (this.config.apiKey) params.set('token', this.config.apiKey);
    if (this.config.accounts.length) params.set('accounts', this.config.accounts.join(','));

    const qs = params.toString();
    return `${base}/ws/events${qs ? `?${qs}` : ''}`;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.config.reconnectIntervalMs);
  }

  private rejectPendingSends(reason: string): void {
    for (const pending of this.pendingSends) {
      pending.reject(new Error(reason));
    }
    this.pendingSends = [];
  }
}
