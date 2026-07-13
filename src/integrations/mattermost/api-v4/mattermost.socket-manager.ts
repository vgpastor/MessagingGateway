import WebSocket from 'ws';
import { getLogger } from '../../../core/logger/logger.port.js';
import type { ConnectionStatus } from '../../../core/accounts/connection-manager.port.js';
import type { MattermostWSEvent, MattermostPostedEvent, MattermostPost } from '../mattermost-channel.types.js';

type MessageHandler = (event: MattermostWSEvent, post: MattermostPost) => void;
type ConnectionHandler = (status: ConnectionStatus) => void;

interface SocketEntry {
  ws: WebSocket | null;
  serverUrl: string;
  token: string;
  botUserId: string;
  status: ConnectionStatus;
  messageHandlers: MessageHandler[];
  connectionHandlers: ConnectionHandler[];
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  retryCount: number;
  /** Set of post IDs recently processed — dedup guard. */
  seenPostIds: Set<string>;
  /** Whether the stop signal has been received (auth failure). */
  stopped: boolean;
}

const MAX_RECONNECT_DELAY_MS = 60_000;
const BASE_RECONNECT_DELAY_MS = 1_000;
const DEDUP_WINDOW_MS = 30_000;

export class MattermostSocketManager {
  private sockets = new Map<string, SocketEntry>();

  async connect(accountId: string, serverUrl: string, token: string, botUserId: string): Promise<void> {
    if (this.sockets.has(accountId)) return;

    const entry: SocketEntry = {
      ws: null,
      serverUrl,
      token,
      botUserId,
      status: 'connecting',
      messageHandlers: [],
      connectionHandlers: [],
      reconnectTimer: null,
      retryCount: 0,
      seenPostIds: new Set(),
      stopped: false,
    };

    this.sockets.set(accountId, entry);
    await this.openSocket(accountId, entry);
  }

  private async openSocket(accountId: string, entry: SocketEntry): Promise<void> {
    const wsUrl = entry.serverUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:') + '/api/v4/websocket';

    const ws = new WebSocket(wsUrl);
    entry.ws = ws;

    ws.on('open', () => {
      getLogger().info('Mattermost WebSocket opened', { provider: 'mattermost', accountId });
      // Send authentication challenge
      ws.send(JSON.stringify({
        seq: 1,
        action: 'authentication_challenge',
        data: { token: entry.token },
      }));
    });

    ws.on('message', (data) => {
      try {
        const raw = JSON.parse(String(data)) as MattermostWSEvent;
        this.handleFrame(accountId, entry, raw);
      } catch {
        // Ignore malformed frames
      }
    });

    ws.on('close', (code) => {
      getLogger().info('Mattermost WebSocket closed', { provider: 'mattermost', accountId, code });
      entry.ws = null;
      entry.status = 'disconnected';
      this.notifyConnectionHandlers(entry);

      if (!entry.stopped && entry.retryCount < 10) {
        this.scheduleReconnect(accountId, entry);
      }
    });

    ws.on('error', (err) => {
      getLogger().error('Mattermost WebSocket error', {
        provider: 'mattermost',
        accountId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  private handleFrame(accountId: string, entry: SocketEntry, event: MattermostWSEvent): void {
    // Log all events for debugging
    getLogger().debug('Mattermost WS event received', {
      provider: 'mattermost',
      accountId,
      eventType: event.event,
      seq: event.seq,
    });

    if (event.event === 'hello') {
      entry.status = 'connected';
      entry.retryCount = 0;
      getLogger().info('Mattermost WebSocket authenticated', { provider: 'mattermost', accountId });
      this.notifyConnectionHandlers(entry);
      return;
    }

    if (event.event === 'posted') {
      const data = event.data as Record<string, unknown>;
      const rawPost = typeof data.post === 'string' ? data.post : undefined;
      if (!rawPost) {
        getLogger().warn('posted event with no post data', { provider: 'mattermost', accountId, dataKeys: Object.keys(data) });
        return;
      }

      const post = JSON.parse(rawPost) as MattermostPost;

      getLogger().info('Mattermost posted event received', {
        provider: 'mattermost',
        accountId,
        postId: post.id,
        userId: post.user_id,
        channelId: post.channel_id,
        message: post.message?.substring(0, 100),
        fileIds: post.file_ids,
        botUserId: entry.botUserId,
      });

      // Skip bot's own messages
      if (post.user_id === entry.botUserId) return;

      // Dedup guard
      if (entry.seenPostIds.has(post.id)) return;
      entry.seenPostIds.add(post.id);

      // Evict old entries periodically
      if (entry.seenPostIds.size > 500) {
        const oldest = entry.seenPostIds.values().next().value;
        if (oldest) entry.seenPostIds.delete(oldest);
      }

      // Notify handlers
      for (const handler of entry.messageHandlers) {
        try {
          handler(event, post);
        } catch (err) {
          getLogger().error('Error in Mattermost message handler', {
            provider: 'mattermost',
            accountId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  private scheduleReconnect(accountId: string, entry: SocketEntry): void {
    entry.retryCount++;
    const delay = Math.min(
      BASE_RECONNECT_DELAY_MS * Math.pow(2, entry.retryCount - 1),
      MAX_RECONNECT_DELAY_MS,
    );

    getLogger().info('Scheduling Mattermost reconnect', {
      provider: 'mattermost',
      accountId,
      attempt: entry.retryCount,
      delayMs: delay,
    });

    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = null;
      void this.openSocket(accountId, entry);
    }, delay);
  }

  private notifyConnectionHandlers(entry: SocketEntry): void {
    for (const handler of entry.connectionHandlers) {
      try {
        handler(entry.status);
      } catch {
        // Non-blocking
      }
    }
  }

  onMessage(accountId: string, handler: MessageHandler): void {
    const entry = this.sockets.get(accountId);
    if (entry) {
      entry.messageHandlers.push(handler);
    }
  }

  onConnectionUpdate(accountId: string, handler: ConnectionHandler): void {
    const entry = this.sockets.get(accountId);
    if (entry) {
      entry.connectionHandlers.push(handler);
    }
  }

  getConnectionStatus(accountId: string): ConnectionStatus {
    return this.sockets.get(accountId)?.status ?? 'disconnected';
  }

  hasSocket(accountId: string): boolean {
    return this.sockets.has(accountId);
  }

  async disconnect(accountId: string): Promise<void> {
    const entry = this.sockets.get(accountId);
    if (!entry) return;

    entry.stopped = true;
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = null;
    }
    if (entry.ws) {
      entry.ws.close();
      entry.ws = null;
    }
    entry.status = 'disconnected';
    this.sockets.delete(accountId);
  }
}

/** Module-level singleton — shared across messaging, connection, health, and wireEvents */
export const mattermostSocketManager = new MattermostSocketManager();
