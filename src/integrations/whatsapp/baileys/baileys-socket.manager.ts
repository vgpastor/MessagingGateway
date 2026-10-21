import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  type WASocket,
  type WAVersion,
  type BaileysEventMap,
} from '@whiskeysockets/baileys';
import type { Boom } from '@hapi/boom';
import { resolve, sep } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import type { BaileysProviderConfig } from './baileys.types.js';
import { getLogger } from '../../../core/logger/logger.port.js';
import { computeBackoffMs } from '../../../core/util/backoff.js';
import type { SocketManagerPort, ConnectionStatus } from '../../../core/providers/socket-manager.port.js';
import type { GroupInfo } from '../../../core/groups/group.types.js';

/**
 * Fallback WhatsApp Web version, used only when {@link fetchLatestBaileysVersion}
 * fails (e.g. no network at startup). WhatsApp rejects new device links from
 * outdated versions, so the live version is always preferred.
 */
const FALLBACK_WA_VERSION: WAVersion = [2, 3000, 1034074495];

type BaileysMessageHandler = (event: BaileysEventMap['messages.upsert']) => void;
type BaileysConnectionHandler = (update: Partial<BaileysEventMap['connection.update']>) => void;

interface SocketEntry {
  socket: WASocket;
  config: BaileysProviderConfig;
  connectionStatus: ConnectionStatus;
  lastQr: string | undefined;
}

export interface BaileysSocketManagerOptions {
  /** Jitter source for the reconnect backoff (inject a fixed value in tests). */
  random?: () => number;
}

export class BaileysSocketManager implements SocketManagerPort<BaileysProviderConfig> {
  private sockets = new Map<string, SocketEntry>();
  /**
   * Inbound subscriptions, keyed by account and kept OUTSIDE {@link SocketEntry}.
   *
   * Handlers belong to the account, not to whichever socket happens to be open:
   * they are registered once at startup (`wireEvents`) while sockets come and go
   * on every reconnect and on {@link clearSession}. Storing them on the entry
   * meant a re-paired account silently stopped delivering messages until the
   * process restarted.
   */
  private messageHandlers = new Map<string, BaileysMessageHandler[]>();
  private connectionHandlers = new Map<string, BaileysConnectionHandler[]>();
  private cachedWaVersion: WAVersion | undefined;
  /** Accounts whose session is being cleared; blocks (re)connects during teardown. */
  private clearing = new Set<string>();
  /** Accounts with a connect() in flight; stops two callers from opening two sockets. */
  private connecting = new Set<string>();
  /**
   * Accounts WhatsApp unlinked (401 loggedOut) or that were disconnected on
   * purpose: a retry cannot help, only an explicit connect (re-pairing) revives them.
   */
  private loggedOut = new Set<string>();
  /** Pending backoff timer per account; at most one, so a reconnect is never stacked. */
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Consecutive failed attempts per account, kept OUTSIDE {@link SocketEntry}
   * because the entry is replaced on every reconnect. Reset when the socket opens.
   */
  private reconnectAttempts = new Map<string, number>();

  constructor(private readonly options: BaileysSocketManagerOptions = {}) {}

  async connect(accountId: string, config: BaileysProviderConfig): Promise<void> {
    if (this.clearing.has(accountId)) {
      return;
    }

    if (this.sockets.has(accountId) || this.connecting.has(accountId)) {
      return;
    }

    // An explicit connect (e.g. re-pairing after a logout) takes over from any
    // scheduled reconnect and clears the logged-out flag.
    this.clearReconnectTimer(accountId);
    this.loggedOut.delete(accountId);

    this.connecting.add(accountId);
    try {
      await this.openSocket(accountId, config);
    } finally {
      this.connecting.delete(accountId);
    }
  }

  /** Open the socket for an account that has none; {@link connect} owns the guards. */
  private async openSocket(accountId: string, config: BaileysProviderConfig): Promise<void> {
    const authDir = this.resolveAuthDir(accountId, config);
    await mkdir(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const version = await this.resolveWaVersion(config);

    const socket = makeWASocket({
      auth: state,
      browser: config.browser ?? ['MessagingGateway', 'Chrome', '1.0.0'],
      version,
      connectTimeoutMs: config.connectTimeoutMs ?? 60_000,
      qrTimeout: config.qrTimeoutMs ?? 60_000,
      markOnlineOnConnect: config.markOnlineOnConnect ?? true,
    });

    const entry: SocketEntry = {
      socket,
      config,
      connectionStatus: 'connecting',
      lastQr: undefined,
    };

    this.sockets.set(accountId, entry);

    socket.ev.on('creds.update', saveCreds);

    socket.ev.on('connection.update', (update) => {
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
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        const shouldReconnect =
          !loggedOut &&
          (config.retryOnDisconnect ?? true) &&
          !this.clearing.has(accountId);
        // A close from a socket that was already replaced or dropped is stale
        // news: it must neither schedule a second reconnect nor evict its successor.
        const isCurrent = this.sockets.get(accountId) === entry;

        if (shouldReconnect) {
          // Keep the dead entry (status 'disconnected', QR intact) until the
          // timer replaces it, so the account stays registered while it backs off.
          if (isCurrent) {
            this.scheduleReconnect(accountId, config, statusCode);
          }
        } else {
          getLogger().info('Connection closed permanently', { provider: 'baileys', accountId, statusCode, loggedOut });
          if (loggedOut) {
            this.loggedOut.add(accountId);
          }
          this.cancelReconnect(accountId);
          if (isCurrent) {
            this.sockets.delete(accountId);
          }
        }
      } else if (connection === 'open') {
        this.reconnectAttempts.delete(accountId);
        entry.connectionStatus = 'connected';
        entry.lastQr = undefined;
        getLogger().info('Connection established', { provider: 'baileys', accountId });
      }

      // Notify after the state above is updated, so handlers that read
      // getConnectionStatus() see 'connected' on open, not the previous status.
      for (const handler of this.handlersFor(this.connectionHandlers, accountId)) {
        handler(update);
      }
    });

    socket.ev.on('messages.upsert', (event) => {
      const handlers = this.handlersFor(this.messageHandlers, accountId);
      getLogger().info('messages.upsert received', { provider: 'baileys', accountId, messageCount: event.messages.length, type: event.type, handlers: handlers.length });
      for (const handler of handlers) {
        handler(event);
      }
    });

  }

  getSocket(accountId: string): WASocket | undefined {
    return this.sockets.get(accountId)?.socket;
  }

  onMessage(accountId: string, handler: BaileysMessageHandler): void {
    this.register(this.messageHandlers, accountId, handler);
  }

  onConnectionUpdate(accountId: string, handler: BaileysConnectionHandler): void {
    this.register(this.connectionHandlers, accountId, handler);
  }

  /**
   * Registration does not require an open socket: subscribing before the first
   * {@link connect}, or between a teardown and the reconnect, is valid and the
   * handler still receives every later event.
   */
  private register<T>(registry: Map<string, T[]>, accountId: string, handler: T): void {
    const handlers = registry.get(accountId);
    if (handlers) {
      handlers.push(handler);
      return;
    }
    registry.set(accountId, [handler]);
  }

  private handlersFor<T>(registry: Map<string, T[]>, accountId: string): readonly T[] {
    return registry.get(accountId) ?? [];
  }

  /** Drop an account's subscriptions. Only for accounts that are going away. */
  private forgetHandlers(accountId: string): void {
    this.messageHandlers.delete(accountId);
    this.connectionHandlers.delete(accountId);
  }

  async disconnect(accountId: string): Promise<void> {
    // logout() unlinks the device: the account is done, not just closed. Forget
    // the handlers first so the 401 close that logout() emits is not reported
    // as an unexpected session loss (and alerted).
    this.forgetHandlers(accountId);
    this.cancelReconnect(accountId);
    this.loggedOut.add(accountId);
    const entry = this.sockets.get(accountId);
    if (entry) {
      await entry.socket.logout().catch(() => {});
      this.sockets.delete(accountId);
    }
  }

  /**
   * Close the socket locally and delete the persisted multi-file auth state so
   * the next {@link connect} starts a fresh pairing and emits a new QR.
   *
   * Unlike {@link disconnect} this does NOT call `logout()` (a network round-trip
   * that can hang on expired creds) — the files are deleted anyway. The account
   * is flagged in {@link clearing} for the duration so the auto-reconnect loop
   * can't recreate the auth dir mid-teardown.
   *
   * ponytail: a connect already in flight *before* this call (past the clearing
   * check) could still race the delete; acceptable — worst case is an extra fresh
   * QR. Pending backoff timers are cancelled above, so only that window remains.
   */
  async clearSession(accountId: string, config: BaileysProviderConfig): Promise<void> {
    const authDir = this.resolveAuthDir(accountId, config);
    this.assertDeletableAuthDir(authDir);

    this.clearing.add(accountId);
    this.cancelReconnect(accountId);
    try {
      const entry = this.sockets.get(accountId);
      if (entry) {
        // Drop the connection handlers first so the imminent 'close' can't
        // schedule a reconnect, then close locally (no network logout).
        try { entry.socket.ev.removeAllListeners('connection.update'); } catch { /* best-effort */ }
        try { entry.socket.end(undefined); } catch { /* best-effort */ }
        this.sockets.delete(accountId);
      }
      await rm(authDir, { recursive: true, force: true });
      getLogger().info('Session cleared', { provider: 'baileys', accountId, authDir });
    } finally {
      this.clearing.delete(accountId);
    }
  }

  /**
   * Guard the destructive {@link clearSession} `rm -rf`: refuse to delete any
   * path outside the managed auth root. `authDir` comes from per-account
   * `providerConfig`, which the account-creation API accepts as free-form, so an
   * unchecked value like `../../..` would delete arbitrary directories.
   */
  private assertDeletableAuthDir(authDir: string): void {
    const root = resolve(process.cwd(), 'data', 'baileys-auth');
    if (!authDir.startsWith(root + sep)) {
      const error = new Error(`Refusing to delete auth dir outside '${root}': '${authDir}'`);
      (error as { code?: string }).code = 'INVALID_AUTH_DIR';
      throw error;
    }
  }

  isConnected(accountId: string): boolean {
    const entry = this.sockets.get(accountId);
    return entry?.connectionStatus === 'connected';
  }

  /**
   * Reconnect an account that has no socket (health-checker entry point).
   *
   * No-ops, returning false, when a reconnect is already covered: the account
   * has a socket (even a dead one waiting out its backoff), a timer is pending,
   * a connect is in flight, its session is being cleared, it is logged out
   * (needs a QR, not a retry), it opted out with `retryOnDisconnect: false`, or
   * its event subscriptions are not registered yet. That last guard stops the
   * startup credential validation from opening sockets before the inbound wiring
   * exists (a lost `open`, dropped offline messages): wiring is what makes an
   * account eligible. A failed attempt is retried with backoff.
   *
   * @returns whether a connect was started
   */
  ensureConnected(accountId: string, config: BaileysProviderConfig): boolean {
    if (
      this.sockets.has(accountId) ||
      this.connecting.has(accountId) ||
      this.reconnectTimers.has(accountId) ||
      this.clearing.has(accountId) ||
      this.loggedOut.has(accountId) ||
      !this.isWired(accountId) ||
      config.retryOnDisconnect === false
    ) {
      return false;
    }
    getLogger().info('Account has no socket, reconnecting', { provider: 'baileys', accountId });
    void this.reconnect(accountId, config);
    return true;
  }

  /** Whether the account's inbound/connection subscriptions have been registered. */
  private isWired(accountId: string): boolean {
    return this.messageHandlers.has(accountId) || this.connectionHandlers.has(accountId);
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

  /**
   * Schedule the next attempt with exponential backoff + full jitter. There is
   * no attempt ceiling: a short network blip must never kill an account. Only a
   * 401 (needs a QR), an explicit disconnect or a session reset stop the loop.
   */
  private scheduleReconnect(accountId: string, config: BaileysProviderConfig, statusCode: number | undefined): void {
    if (this.reconnectTimers.has(accountId)) {
      return;
    }
    const attempt = this.reconnectAttempts.get(accountId) ?? 0;
    this.reconnectAttempts.set(accountId, attempt + 1);
    const delayMs = Math.round(computeBackoffMs(attempt, { random: this.options.random }));

    getLogger().info('Connection closed, reconnecting', { provider: 'baileys', accountId, statusCode, attempt: attempt + 1, delayMs });

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(accountId);
      void this.reconnect(accountId, config);
    }, delayMs);
    timer.unref?.();
    this.reconnectTimers.set(accountId, timer);
  }

  /** Stop any scheduled attempt and forget the failure streak (account is going away or restarting). */
  private cancelReconnect(accountId: string): void {
    this.clearReconnectTimer(accountId);
    this.reconnectAttempts.delete(accountId);
  }

  private clearReconnectTimer(accountId: string): void {
    const timer = this.reconnectTimers.get(accountId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(accountId);
    }
  }

  /** Replace the dead socket (if any) with a new one; on failure, back off and try again. */
  private async reconnect(accountId: string, config: BaileysProviderConfig): Promise<void> {
    if (this.clearing.has(accountId) || this.loggedOut.has(accountId)) {
      return;
    }
    // Carry the last QR over so the API can keep serving it until a new one arrives.
    const prevQr = this.sockets.get(accountId)?.lastQr;
    this.sockets.delete(accountId);

    try {
      await this.connect(accountId, config);
      const entry = this.sockets.get(accountId);
      if (entry && !entry.lastQr && prevQr) {
        entry.lastQr = prevQr;
      }
    } catch (err) {
      getLogger().error('Reconnection failed', { provider: 'baileys', accountId, error: err instanceof Error ? err.message : String(err) });
      this.scheduleReconnect(accountId, config, undefined);
    }
  }

  /**
   * Resolve the WhatsApp Web version to advertise when opening a socket.
   *
   * Priority: explicit per-account `waVersion` → the latest version reported by
   * Baileys (fetched once and cached for the process lifetime) → the hardcoded
   * {@link FALLBACK_WA_VERSION}. Keeping the version current is what prevents
   * WhatsApp from rejecting new device links ("couldn't link device").
   */
  private async resolveWaVersion(config: BaileysProviderConfig): Promise<WAVersion> {
    if (config.waVersion) {
      return config.waVersion;
    }
    if (this.cachedWaVersion) {
      return this.cachedWaVersion;
    }
    try {
      const { version } = await fetchLatestBaileysVersion();
      this.cachedWaVersion = version;
      getLogger().info('Fetched latest WhatsApp Web version', { provider: 'baileys', version });
      return version;
    } catch (error) {
      getLogger().warn('Could not fetch latest WhatsApp Web version, using fallback', {
        provider: 'baileys',
        fallback: FALLBACK_WA_VERSION,
        error: error instanceof Error ? error.message : String(error),
      });
      return FALLBACK_WA_VERSION;
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

