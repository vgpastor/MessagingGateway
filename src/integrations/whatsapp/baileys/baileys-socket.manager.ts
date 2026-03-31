import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  type WASocket,
  type BaileysEventMap,
} from '@whiskeysockets/baileys';
import type { Boom } from '@hapi/boom';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { BaileysProviderConfig } from './baileys.types.js';

type MessageHandler = (event: BaileysEventMap['messages.upsert']) => void;
type ConnectionHandler = (update: Partial<BaileysEventMap['connection.update']>) => void;

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

interface SocketEntry {
  socket: WASocket;
  config: BaileysProviderConfig;
  retryCount: number;
  connectionStatus: ConnectionStatus;
  lastQr: string | undefined;
  messageHandlers: MessageHandler[];
  connectionHandlers: ConnectionHandler[];
}

export class BaileysSocketManager {
  private sockets = new Map<string, SocketEntry>();

  async connect(accountId: string, config: BaileysProviderConfig): Promise<WASocket> {
    const existing = this.sockets.get(accountId);
    if (existing) {
      return existing.socket;
    }

    const authDir = this.resolveAuthDir(accountId, config);
    await mkdir(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const socket = makeWASocket({
      auth: state,
      browser: config.browser ?? ['MessagingGateway', 'Chrome', '1.0.0'],
      version: config.waVersion ?? [2, 3000, 1034074495],
      connectTimeoutMs: config.connectTimeoutMs ?? 60_000,
      markOnlineOnConnect: config.markOnlineOnConnect ?? true,
    });

    const entry: SocketEntry = {
      socket,
      config,
      retryCount: 0,
      connectionStatus: 'connecting',
      lastQr: undefined,
      messageHandlers: [],
      connectionHandlers: [],
    };

    this.sockets.set(accountId, entry);

    socket.ev.on('creds.update', saveCreds);

    socket.ev.on('connection.update', (update) => {
      for (const handler of entry.connectionHandlers) {
        handler(update);
      }

      if (update.qr) {
        entry.lastQr = update.qr;
        entry.connectionStatus = 'connecting';
        console.log(`[baileys:${accountId}] QR code received (poll GET /api/v1/accounts/${accountId} to retrieve it)`);
      }

      const { connection, lastDisconnect } = update;

      if (connection === 'close') {
        entry.connectionStatus = 'disconnected';
        // Keep lastQr across reconnections so the API can still serve it
        const error = lastDisconnect?.error as Boom | undefined;
        const statusCode = error?.output?.statusCode;
        const shouldReconnect =
          statusCode !== DisconnectReason.loggedOut &&
          (config.retryOnDisconnect ?? true);
        const maxRetries = config.maxRetries ?? 5;

        if (shouldReconnect && entry.retryCount < maxRetries) {
          entry.retryCount++;
          console.log(
            `[baileys:${accountId}] Connection closed (status=${statusCode}), reconnecting (attempt ${entry.retryCount}/${maxRetries})...`,
          );
          // Remove the old socket but preserve handlers and QR for the new entry
          const prevHandlers = entry.messageHandlers;
          const prevConnectionHandlers = entry.connectionHandlers;
          const prevQr = entry.lastQr;
          const prevRetryCount = entry.retryCount;
          this.sockets.delete(accountId);

          void this.connect(accountId, config).then(() => {
            const newEntry = this.sockets.get(accountId);
            if (newEntry) {
              newEntry.messageHandlers = prevHandlers;
              newEntry.connectionHandlers = prevConnectionHandlers;
              newEntry.retryCount = prevRetryCount;
              // Preserve QR until a new one is received
              if (!newEntry.lastQr && prevQr) {
                newEntry.lastQr = prevQr;
              }
            }
          }).catch((err) => {
            console.error(`[baileys:${accountId}] Reconnection failed:`, err);
          });
        } else {
          console.log(
            `[baileys:${accountId}] Connection closed permanently (status=${statusCode}, loggedOut=${statusCode === DisconnectReason.loggedOut})`,
          );
          this.sockets.delete(accountId);
        }
      } else if (connection === 'open') {
        entry.retryCount = 0;
        entry.connectionStatus = 'connected';
        entry.lastQr = undefined;
        console.log(`[baileys:${accountId}] Connection established`);
      }
    });

    socket.ev.on('messages.upsert', (event) => {
      console.log(`[baileys:${accountId}] messages.upsert: ${event.messages.length} message(s), type=${event.type}, handlers=${entry.messageHandlers.length}`);
      for (const handler of entry.messageHandlers) {
        handler(event);
      }
    });

    return socket;
  }

  getSocket(accountId: string): WASocket | undefined {
    return this.sockets.get(accountId)?.socket;
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

  async disconnect(accountId: string): Promise<void> {
    const entry = this.sockets.get(accountId);
    if (entry) {
      await entry.socket.logout().catch(() => {});
      this.sockets.delete(accountId);
    }
  }

  isConnected(accountId: string): boolean {
    const entry = this.sockets.get(accountId);
    return entry?.connectionStatus === 'connected';
  }

  hasSocket(accountId: string): boolean {
    return this.sockets.has(accountId);
  }

  getConnectionStatus(accountId: string): ConnectionStatus {
    return this.sockets.get(accountId)?.connectionStatus ?? 'disconnected';
  }

  getLastQr(accountId: string): string | undefined {
    return this.sockets.get(accountId)?.lastQr;
  }

  async requestPairingCode(accountId: string, phoneNumber: string): Promise<string> {
    const entry = this.sockets.get(accountId);
    if (!entry) {
      throw new Error(`No socket for account '${accountId}'. Connect first.`);
    }

    if (entry.connectionStatus === 'connected') {
      throw new Error(`Account '${accountId}' is already connected.`);
    }

    // Clean phone number: remove +, spaces, dashes
    const cleaned = phoneNumber.replace(/[^0-9]/g, '');
    const code = await entry.socket.requestPairingCode(cleaned);
    return code;
  }

  resolveAuthDir(accountId: string, config: BaileysProviderConfig): string {
    if (config.authDir) {
      return resolve(process.cwd(), config.authDir);
    }
    return resolve(process.cwd(), 'data', 'baileys-auth', accountId);
  }
}

export const baileysSocketManager = new BaileysSocketManager();
