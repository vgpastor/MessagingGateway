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
import { getLogger } from '../../../core/logger/logger.port.js';
import type { SocketManagerPort, ConnectionStatus } from '../../../core/providers/socket-manager.port.js';
import type { GroupInfo } from '../../../core/groups/group.types.js';

type BaileysMessageHandler = (event: BaileysEventMap['messages.upsert']) => void;
type BaileysConnectionHandler = (update: Partial<BaileysEventMap['connection.update']>) => void;

interface SocketEntry {
  socket: WASocket;
  config: BaileysProviderConfig;
  retryCount: number;
  connectionStatus: ConnectionStatus;
  lastQr: string | undefined;
  messageHandlers: BaileysMessageHandler[];
  connectionHandlers: BaileysConnectionHandler[];
}

export class BaileysSocketManager implements SocketManagerPort<BaileysProviderConfig> {
  private sockets = new Map<string, SocketEntry>();

  async connect(accountId: string, config: BaileysProviderConfig): Promise<void> {
    const existing = this.sockets.get(accountId);
    if (existing) {
      return;
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
        getLogger().info('QR code received', { provider: 'baileys', accountId, hint: `poll GET /api/v1/accounts/${accountId} to retrieve it` });
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
          getLogger().info('Connection closed, reconnecting', { provider: 'baileys', accountId, statusCode, attempt: entry.retryCount, maxRetries });
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
            getLogger().error('Reconnection failed', { provider: 'baileys', accountId, error: err instanceof Error ? err.message : String(err) });
          });
        } else {
          getLogger().info('Connection closed permanently', { provider: 'baileys', accountId, statusCode, loggedOut: statusCode === DisconnectReason.loggedOut });
          this.sockets.delete(accountId);
        }
      } else if (connection === 'open') {
        entry.retryCount = 0;
        entry.connectionStatus = 'connected';
        entry.lastQr = undefined;
        getLogger().info('Connection established', { provider: 'baileys', accountId });
      }
    });

    socket.ev.on('messages.upsert', (event) => {
      getLogger().info('messages.upsert received', { provider: 'baileys', accountId, messageCount: event.messages.length, type: event.type, handlers: entry.messageHandlers.length });
      for (const handler of entry.messageHandlers) {
        handler(event);
      }
    });

  }

  getSocket(accountId: string): WASocket | undefined {
    return this.sockets.get(accountId)?.socket;
  }

  onMessage(accountId: string, handler: BaileysMessageHandler): void {
    const entry = this.sockets.get(accountId);
    if (entry) {
      entry.messageHandlers.push(handler);
    }
  }

  onConnectionUpdate(accountId: string, handler: BaileysConnectionHandler): void {
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

  async getGroups(accountId: string): Promise<GroupInfo[]> {
    const socket = this.getSocket(accountId);
    if (!socket) return [];
    const groups = await socket.groupFetchAllParticipating();
    return Object.values(groups).map(g => ({
      id: g.id,
      name: g.subject,
      description: g.desc ?? undefined,
      participants: g.participants.map(p => ({
        id: p.id,
        isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
        isSuperAdmin: p.admin === 'superadmin',
      })),
      createdAt: g.creation ? new Date(g.creation * 1000).toISOString() : undefined,
      createdBy: g.subjectOwner ?? undefined,
      isAnnouncement: g.announce ?? false,
    }));
  }

  async getGroupInfo(accountId: string, groupId: string): Promise<GroupInfo | undefined> {
    const socket = this.getSocket(accountId);
    if (!socket) return undefined;
    try {
      const metadata = await socket.groupMetadata(groupId);
      return {
        id: metadata.id,
        name: metadata.subject,
        description: metadata.desc ?? undefined,
        participants: metadata.participants.map(p => ({
          id: p.id,
          isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
          isSuperAdmin: p.admin === 'superadmin',
        })),
        createdAt: metadata.creation ? new Date(metadata.creation * 1000).toISOString() : undefined,
        createdBy: metadata.subjectOwner ?? undefined,
        isAnnouncement: metadata.announce ?? false,
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Resolve a WhatsApp LID (e.g. "266563471069327@lid") to a phone-number JID
   * (e.g. "34643506783@s.whatsapp.net") using Baileys' built-in LID mapping store.
   * Returns undefined if the mapping is not found.
   */
  async resolveLidToPhone(accountId: string, lid: string): Promise<string | undefined> {
    const socket = this.getSocket(accountId);
    if (!socket) return undefined;
    try {
      const pn = await (socket as unknown as { signalRepository: { lidMapping: { getPNForLID(lid: string): Promise<string | null> } } })
        .signalRepository.lidMapping.getPNForLID(lid);
      return pn ?? undefined;
    } catch {
      return undefined;
    }
  }

  resolveAuthDir(accountId: string, config: BaileysProviderConfig): string {
    if (config.authDir) {
      return resolve(process.cwd(), config.authDir);
    }
    return resolve(process.cwd(), 'data', 'baileys-auth', accountId);
  }
}

/** Create a new BaileysSocketManager instance (useful for testing) */
export function createBaileysSocketManager(): BaileysSocketManager {
  return new BaileysSocketManager();
}

/** Default singleton instance */
export const baileysSocketManager = createBaileysSocketManager();
