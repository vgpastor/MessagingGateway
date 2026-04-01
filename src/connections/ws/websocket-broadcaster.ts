import type { WebSocket } from '@fastify/websocket';
import type { EventBus } from '../../core/event-bus.js';
import type { SendMessageCommand } from '../../core/messaging/outbound-message.js';
import { Events, createEvent } from '../../core/events.js';
import type { MessageInboundPayload, ConnectionUpdatePayload, MessageSendSuccessPayload, MessageSendFailurePayload, MessageSendRequestPayload } from '../../core/events.js';

interface WsClient {
  socket: WebSocket;
  accountFilter: Set<string> | null; // null = all accounts
}

export class WebSocketBroadcaster {
  private clients = new Set<WsClient>();

  constructor(private readonly eventBus: EventBus) {
    this.subscribe();
  }

  addClient(socket: WebSocket, accounts?: string[]): void {
    const client: WsClient = {
      socket,
      accountFilter: accounts?.length ? new Set(accounts) : null,
    };
    this.clients.add(client);

    socket.on('message', (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.action === 'subscribe' && Array.isArray(msg.accounts)) {
          client.accountFilter = msg.accounts.length ? new Set(msg.accounts) : null;
          this.sendTo(socket, { event: 'subscribed', accounts: msg.accounts });
        } else if (msg.action === 'unsubscribe' && Array.isArray(msg.accounts)) {
          for (const id of msg.accounts) {
            client.accountFilter?.delete(id);
          }
          if (client.accountFilter?.size === 0) client.accountFilter = null;
          this.sendTo(socket, { event: 'unsubscribed', accounts: msg.accounts });
        } else if (msg.action === 'send' && msg.data) {
          this.handleSend(socket, msg.data, msg.id);
        } else if (msg.action === 'ping') {
          this.sendTo(socket, { event: 'pong' });
        }
      } catch {
        // Ignore malformed messages
      }
    });

    socket.on('close', () => {
      this.clients.delete(client);
    });

    socket.on('error', () => {
      this.clients.delete(client);
    });

    this.sendTo(socket, {
      event: 'connected',
      accounts: accounts ?? [],
      message: 'WebSocket connected. Send {"action":"subscribe","accounts":["id"]} to filter.',
    });
  }

  get clientCount(): number {
    return this.clients.size;
  }

  private handleSend(socket: WebSocket, data: Record<string, unknown>, correlationId?: string): void {
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
      this.sendTo(socket, {
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
      this.broadcast(event.accountId, 'connection.update', event.data, event.timestamp);
    });

    this.eventBus.on<MessageSendSuccessPayload>(Events.MESSAGE_SEND_SUCCESS, (event) => {
      this.broadcast(event.accountId, 'message.sent', event.data, event.timestamp);
    });

    this.eventBus.on<MessageSendFailurePayload>(Events.MESSAGE_SEND_FAILURE, (event) => {
      this.broadcast(event.accountId, 'message.send.failed', event.data, event.timestamp);
    });
  }

  private broadcast(accountId: string | undefined, eventType: string, data: unknown, timestamp: Date): void {
    const message = JSON.stringify({ event: eventType, timestamp: timestamp.toISOString(), data });

    for (const client of this.clients) {
      if (client.socket.readyState !== 1) continue; // OPEN
      if (accountId && client.accountFilter && !client.accountFilter.has(accountId)) continue;

      try {
        client.socket.send(message);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  private sendTo(socket: WebSocket, data: unknown): void {
    if (socket.readyState === 1) {
      socket.send(JSON.stringify(data));
    }
  }
}
