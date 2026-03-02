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
      printQRInTerminal: config.printQRInTerminal ?? true,
      browser: config.browser ?? ['MessagingGateway', 'Chrome', '1.0.0'],
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
      }

      const { connection, lastDisconnect } = update;

      if (connection === 'close') {
        entry.connectionStatus = 'disconnected';
        entry.lastQr = undefined;
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
          this.sockets.delete(accountId);
          void this.connect(accountId, config).catch((err) => {
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
