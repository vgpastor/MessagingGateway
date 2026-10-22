import type { WebSocket } from '@fastify/websocket';
import type { EventBus } from '../../core/event-bus.js';
import type { SendMessageCommand } from '../../core/messaging/outbound-message.js';
import { Events, createEvent } from '../../core/events.js';
import type { MessageInboundPayload, ConnectionUpdatePayload, MessageSendSuccessPayload, MessageSendFailurePayload, MessageSendRequestPayload } from '../../core/events.js';
import type { AuthScope } from '../../core/auth/api-key.guard.js';
import type { MetricsPort } from '../../core/metrics/metrics.port.js';
import { noopMetrics } from '../../core/metrics/metrics.port.js';

/** WebSocket readyState value for OPEN connection */
const WS_OPEN = 1;

/** How often every client is pinged; one that did not answer the previous ping is terminated. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

interface WsClient {
  socket: WebSocket;
  accountFilter: Set<string> | null; // null = all accounts
  /** `read` clients can listen but not send, and never get QR codes. */
  scope: AuthScope;
  /** False from the moment a ping goes out until the client answers (pong) or sends anything. */
  isAlive: boolean;
}

export interface WebSocketBroadcasterOptions {
  heartbeatIntervalMs?: number;
}

export class WebSocketBroadcaster {
  private clients = new Set<WsClient>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly heartbeatIntervalMs: number;

  constructor(
    private readonly eventBus: EventBus,
    private readonly metrics: MetricsPort = noopMetrics,
    options: WebSocketBroadcasterOptions = {},
  ) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.subscribe();
  }

  addClient(socket: WebSocket, accounts?: string[], scope: AuthScope = 'admin'): void {
    const client: WsClient = {
      socket,
      accountFilter: accounts?.length ? new Set(accounts) : null,
      scope,
      isAlive: true,
    };
    this.clients.add(client);
    this.metrics.incGauge('umg_ws_clients_connected');
    this.startHeartbeat();

    socket.on('pong', () => {
      client.isAlive = true;
    });

    socket.on('message', (raw: Buffer | string) => {
      client.isAlive = true;
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.action === 'subscribe' && Array.isArray(msg.accounts)) {
          client.accountFilter = msg.accounts.length ? new Set(msg.accounts) : null;
          this.sendTo(client, { event: 'subscribed', accounts: msg.accounts });
        } else if (msg.action === 'unsubscribe' && Array.isArray(msg.accounts)) {
          for (const id of msg.accounts) {
            client.accountFilter?.delete(id);
          }
          if (client.accountFilter?.size === 0) client.accountFilter = null;
          this.sendTo(client, { event: 'unsubscribed', accounts: msg.accounts });
        } else if (msg.action === 'send' && msg.data) {
          if (client.scope === 'read') {
            this.sendTo(client, {
              event: 'message.send.failed',
              replyTo: msg.id,
              data: { error: 'Forbidden: a read-only API key cannot send messages' },
            });
          } else {
            this.handleSend(client, msg.data, msg.id);
          }
        } else if (msg.action === 'ping') {
          this.sendTo(client, { event: 'pong' });
        }
      } catch {
        // Ignore malformed messages
      }
    });

    socket.on('close', () => this.removeClient(client));
    socket.on('error', () => this.removeClient(client));

    this.sendTo(client, {
      event: 'connected',
      accounts: accounts ?? [],
      message: 'WebSocket connected. Send {"action":"subscribe","accounts":["id"]} to filter.',
    });
  }

  get clientCount(): number {
    return this.clients.size;
  }

  private handleSend(client: WsClient, data: Record<string, unknown>, correlationId?: string): void {
    const command: SendMessageCommand = {
      fromAccountId: data.from as string | undefined,
      routing: data.routing as SendMessageCommand['routing'],
      to: data.to as string,
      content: data.content as SendMessageCommand['content'],
      replyToMessageId: data.replyToMessageId as string | undefined,
      metadata: data.metadata as Record<string, unknown> | undefined,
    };

    void this.eventBus.emit(
      createEvent<MessageSendRequestPayload>(
        Events.MESSAGE_SEND_REQUEST,
        'websocket',
        { command, replyTo: correlationId },
      ),
    ).catch((err) => {
      this.sendTo(client, {
        event: 'message.send.failed',
        replyTo: correlationId,
        data: { error: err instanceof Error ? err.message : 'Send failed' },
      });
    });
  }

  private subscribe(): void {
    this.eventBus.on<MessageInboundPayload>(Events.MESSAGE_INBOUND, (event) => {
      this.broadcast(event.accountId, 'message.inbound', event.data.envelope, event.timestamp);
    });

    this.eventBus.on<ConnectionUpdatePayload>(Events.CONNECTION_UPDATE, (event) => {
      // Read-only clients must never see the QR (it would let them take over the WhatsApp account).
      const readData = event.data.qr !== undefined ? { ...event.data, qr: null } : undefined;
      this.broadcast(event.accountId, 'connection.update', event.data, event.timestamp, readData);
    });

    this.eventBus.on<MessageSendSuccessPayload>(Events.MESSAGE_SEND_SUCCESS, (event) => {
      this.broadcast(event.accountId, 'message.sent', event.data, event.timestamp);
    });

    this.eventBus.on<MessageSendFailurePayload>(Events.MESSAGE_SEND_FAILURE, (event) => {
      this.broadcast(event.accountId, 'message.send.failed', event.data, event.timestamp);
    });
  }

  /**
   * Sends an event to every matching client. `readData`, when given, replaces `data` for
   * read-only clients (used to strip secrets such as the QR).
   */
  private broadcast(
    accountId: string | undefined,
    eventType: string,
    data: unknown,
    timestamp: Date,
    readData?: unknown,
  ): void {
    const envelope = (payload: unknown) =>
      JSON.stringify({ event: eventType, timestamp: timestamp.toISOString(), data: payload });
    const message = envelope(data);
    const readMessage = readData === undefined ? message : envelope(readData);

    for (const client of [...this.clients]) {
      if (client.socket.readyState !== WS_OPEN) continue;
      if (accountId && client.accountFilter && !client.accountFilter.has(accountId)) continue;

      this.deliver(client, client.scope === 'read' ? readMessage : message);
    }
  }

  private sendTo(client: WsClient, data: unknown): void {
    if (client.socket.readyState === WS_OPEN) {
      this.deliver(client, JSON.stringify(data));
    }
  }

  /**
   * Sends a frame; a client whose send fails is half-open or gone, so it is terminated and
   * has to reconnect (and catch up) rather than silently missing events.
   */
  private deliver(client: WsClient, message: string): void {
    try {
      client.socket.send(message, (err?: Error) => {
        if (err) this.terminate(client);
      });
    } catch {
      this.terminate(client);
    }
  }

  private terminate(client: WsClient): void {
    this.removeClient(client);
    try {
      client.socket.terminate();
    } catch {
      // Already gone
    }
  }

  /** Idempotent: close, error and terminate may all fire for the same client. */
  private removeClient(client: WsClient): void {
    if (!this.clients.delete(client)) return;
    this.metrics.decGauge('umg_ws_clients_connected');
    if (this.clients.size === 0) this.stopHeartbeat();
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  /** Terminates clients that did not answer the previous ping, then pings the rest. */
  private heartbeat(): void {
    for (const client of [...this.clients]) {
      if (!client.isAlive) {
        this.terminate(client);
        continue;
      }
      client.isAlive = false;
      try {
        client.socket.ping();
      } catch {
        this.terminate(client);
      }
    }
  }
}
