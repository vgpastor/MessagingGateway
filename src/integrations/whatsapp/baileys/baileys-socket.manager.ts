import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  type WASocket,
  type WAVersion,
  type BaileysEventMap,
  type CacheStore,
  type GroupMetadata,
} from '@whiskeysockets/baileys';
import type { Boom } from '@hapi/boom';
import { resolve, sep } from 'node:path';
import { rm } from 'node:fs/promises';
import type { BaileysProviderConfig } from './baileys.types.js';
import { getLogger } from '../../../core/logger/logger.port.js';
import { computeBackoffMs } from '../../../core/util/backoff.js';
import { TtlCache } from '../../../core/util/ttl-cache.js';
import type { BaileysMessageLookup } from './baileys-message-lookup.js';
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
  /** When this socket reached 'open'. */
  openedAt?: number;
}

/**
 * Why an account has no connection and none is coming until an explicit connect:
 * WhatsApp ended the session (`session_lost`) or someone disconnected it (`closed`).
 */
export type ConnectionEnd = 'session_lost' | 'closed';

/** WhatsApp unlinked the device (401) or refuses the account (403): retrying cannot help. */
const SESSION_LOST_CODES: ReadonlySet<number> = new Set([DisconnectReason.loggedOut, DisconnectReason.forbidden]);

/** WhatsApp rejects the version we advertise. Baileys has no name for this code. */
const VERSION_REJECTED_CODE = 405;

/** An open socket this young says nothing about the connection being good: the failure streak stays. */
const STABLE_CONNECTION_MS = 60_000;

/**
 * After a 440 another session holds the account. Coming back soon just kicks that one out, which then
 * does the same to us. Waiting this long keeps the fight harmless, while a passing conflict still heals by itself.
 */
const CONNECTION_REPLACED_MIN_DELAY_MS = 5 * 60 * 1000;

/** A logout is one frame to WhatsApp, and whoever asked for it is waiting: on a bad connection it is not worth more. */
const LOGOUT_TIMEOUT_MS = 5_000;

/** How long a pairing request waits for a socket that is still connecting; the handshake takes a few seconds. */
const PAIRING_READY_TIMEOUT_MS = 15_000;

/** How long Baileys' retry counters and group metadata stay cached. */
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 5000;

/** Baileys types its caches with a generic `get<T>`; ours is typed by value, so adapt once here. */
function asCacheStore(cache: TtlCache<unknown>): CacheStore {
  return cache as unknown as CacheStore;
}

export interface BaileysSocketManagerOptions {
  /** Jitter source for the reconnect backoff (inject a fixed value in tests). */
  random?: () => number;
  /** Where Baileys finds messages it must re-send or retry-decrypt; absent when there is no message log. */
  messageLookup?: BaileysMessageLookup;
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
  /** Accounts a retry cannot help: only an explicit connect (re-pairing) revives them. */
  private ended = new Map<string, ConnectionEnd>();
  /** Pending backoff timer per account; at most one, so a reconnect is never stacked. */
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Consecutive failed attempts per account, kept OUTSIDE {@link SocketEntry}
   * because the entry is replaced on every reconnect. Forgotten only when a socket
   * closes after {@link STABLE_CONNECTION_MS} open: one that opens and drops keeps backing off.
   */
  private reconnectAttempts = new Map<string, number>();
  /** The process is exiting ({@link closeAll}): no socket opens from here on. */
  private closed = false;
  /**
   * Per-account caches handed to Baileys. Kept OUTSIDE {@link SocketEntry} so they
   * survive reconnects, and per account because the same WhatsApp message id can
   * reach two of our accounts (a shared group) and must not share retry counters.
   */
  private retryCounters = new Map<string, TtlCache<unknown>>();
  private groupMetadata = new Map<string, TtlCache<GroupMetadata>>();

  constructor(private readonly options: BaileysSocketManagerOptions = {}) {}

  async connect(accountId: string, config: BaileysProviderConfig): Promise<void> {
    if (this.closed || this.clearing.has(accountId)) {
      return;
    }

    if (this.sockets.has(accountId)) {
      return;
    }

    if (this.connecting.has(accountId)) {
      // It may have been closed since it started, and whoever asks now wants it open.
      this.ended.delete(accountId);
      return;
    }

    // An explicit connect (e.g. re-pairing after a logout) takes over from any
    // scheduled reconnect and clears the flag that kept the account down.
    this.clearReconnectTimer(accountId);
    this.ended.delete(accountId);

    this.connecting.add(accountId);
    try {
      await this.openSocket(accountId, config);
    } catch (err) {
      // No socket means no event: without this nobody would learn the account is down.
      this.notify(this.connectionHandlers, accountId, { connection: 'close' });
      throw err;
    } finally {
      this.connecting.delete(accountId);
    }
  }

  /** Open the socket for an account that has none; {@link connect} owns the guards. */
  private async openSocket(accountId: string, config: BaileysProviderConfig): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.resolveAuthDir(accountId, config));

    const version = await this.resolveWaVersion(config);

    // Either can happen while the awaits above were pending.
    if (this.closed || this.ended.get(accountId) === 'closed') {
      return;
    }

    const socket = makeWASocket({
      auth: state,
      browser: config.browser ?? ['MessagingGateway', 'Chrome', '1.0.0'],
      version,
      connectTimeoutMs: config.connectTimeoutMs ?? 60_000,
      qrTimeout: config.qrTimeoutMs ?? 60_000,
      markOnlineOnConnect: config.markOnlineOnConnect ?? false,
      getMessage: async (key) => {
        if (!key.id || !this.options.messageLookup) return undefined;
        try {
          return await this.options.messageLookup(accountId, key.id);
        } catch {
          return undefined; // never throw into Baileys' retry path
        }
      },
      msgRetryCounterCache: asCacheStore(this.cacheFor(this.retryCounters, accountId)),
      cachedGroupMetadata: async (jid) => this.groupMetadataFor(accountId).get(jid),
    });

    const entry: SocketEntry = {
      socket,
      config,
      connectionStatus: 'connecting',
      lastQr: undefined,
    };

    this.sockets.set(accountId, entry);

    // Baileys does not look at the result: a rejection here would end the process, and every account with it.
    socket.ev.on('creds.update', () => {
      void this.saveCredentials(accountId, saveCreds);
    });

    socket.ev.on('connection.update', (update) => {
      if (update.qr) {
        entry.lastQr = update.qr;
        entry.connectionStatus = 'connecting';
        getLogger().info('QR code received', { provider: 'baileys', accountId, hint: `poll GET /api/v1/accounts/${accountId} to retrieve it` });
      }

      const { connection, lastDisconnect } = update;

      if (connection === 'close') {
        entry.connectionStatus = 'disconnected';
        // It belonged to this connection: nobody can pair with it any more.
        entry.lastQr = undefined;
        const error = lastDisconnect?.error as Boom | undefined;
        const statusCode = error?.output?.statusCode;
        const sessionLost = statusCode !== undefined && SESSION_LOST_CODES.has(statusCode);
        const shouldReconnect =
          !sessionLost &&
          (config.retryOnDisconnect ?? true) &&
          !this.clearing.has(accountId);
        if (statusCode === VERSION_REJECTED_CODE) {
          this.cachedWaVersion = undefined;
        }
        // A close from a socket that was already replaced or dropped is stale
        // news: it must neither schedule a second reconnect nor evict its successor.
        const isCurrent = this.sockets.get(accountId) === entry;

        if (shouldReconnect) {
          // Keep the dead entry (status 'disconnected') until the timer
          // replaces it, so the account stays registered while it backs off.
          if (isCurrent) {
            if (entry.openedAt !== undefined && Date.now() - entry.openedAt >= STABLE_CONNECTION_MS) {
              this.reconnectAttempts.delete(accountId);
            }
            entry.openedAt = undefined;
            this.scheduleReconnect(accountId, config, statusCode);
          }
        } else if (isCurrent) {
          getLogger().info('Connection closed permanently', { provider: 'baileys', accountId, statusCode, sessionLost });
          // disconnect() got here first when the close comes from its own logout().
          if (sessionLost && !this.ended.has(accountId)) {
            this.ended.set(accountId, 'session_lost');
          }
          this.cancelReconnect(accountId);
          this.sockets.delete(accountId);
        }
      } else if (connection === 'open') {
        entry.openedAt = Date.now();
        entry.connectionStatus = 'connected';
        entry.lastQr = undefined;
        getLogger().info('Connection established', { provider: 'baileys', accountId });
      }

      // Notify after the state above is updated, so handlers that read
      // getConnectionStatus() see 'connected' on open, not the previous status.
      this.notify(this.connectionHandlers, accountId, update);
    });

    // A changed group must not be served stale to Baileys when it addresses the group.
    const groupCache = this.groupMetadataFor(accountId);
    socket.ev.on('groups.update', (updates) => {
      for (const update of updates) if (update.id) groupCache.del(update.id);
    });
    socket.ev.on('group-participants.update', (update) => groupCache.del(update.id));

    socket.ev.on('messages.upsert', (event) => {
      const handlers = this.handlersFor(this.messageHandlers, accountId);
      getLogger().info('messages.upsert received', { provider: 'baileys', accountId, messageCount: event.messages.length, type: event.type, handlers: handlers.length });
      this.notify(this.messageHandlers, accountId, event);
    });

  }

  private async saveCredentials(accountId: string, saveCreds: () => Promise<void>): Promise<void> {
    try {
      await saveCreds();
    } catch (err) {
      getLogger().error('Failed to save credentials', { provider: 'baileys', accountId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** A handler that throws must affect neither the next one nor Baileys, which emits these events. */
  private notify<E>(registry: Map<string, Array<(event: E) => void>>, accountId: string, event: E): void {
    for (const handler of this.handlersFor(registry, accountId)) {
      try {
        handler(event);
      } catch (err) {
        getLogger().error('Account event handler failed', { provider: 'baileys', accountId, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  private cacheFor<V>(registry: Map<string, TtlCache<V>>, accountId: string): TtlCache<V> {
    let cache = registry.get(accountId);
    if (!cache) {
      cache = new TtlCache<V>(CACHE_TTL_MS, CACHE_MAX_ENTRIES);
      registry.set(accountId, cache);
    }
    return cache;
  }

  private groupMetadataFor(accountId: string): TtlCache<GroupMetadata> {
    return this.cacheFor(this.groupMetadata, accountId);
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
    // logout() unlinks the device: the account is done, not just closed. Tell the
    // subscribers it was on purpose and then forget them, so the 401 close that
    // logout() emits is not reported as an unexpected session loss (and alerted).
    this.ended.set(accountId, 'closed');
    this.notify(this.connectionHandlers, accountId, { connection: 'close' });
    this.forgetHandlers(accountId);
    this.cancelReconnect(accountId);
    const entry = this.sockets.get(accountId);
    if (entry) {
      await this.logoutWithinLimit(entry.socket);
      // A logout that failed or hung left the socket open.
      this.closeSocket(entry);
      this.sockets.delete(accountId);
    }
  }

  private async logoutWithinLimit(socket: WASocket): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, LOGOUT_TIMEOUT_MS);
    });
    try {
      await Promise.race([socket.logout().catch(() => {}), limit]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * For a process exit: close every socket locally and stop reconnecting. Unlike
   * {@link disconnect} there is no `logout()`, which would unlink the device, and unlike
   * {@link clearSession} the auth state stays on disk, so the next start resumes each session.
   * Messages that arrive before the socket closes still reach their handlers.
   */
  closeAll(): void {
    this.closed = true;
    for (const accountId of [...this.reconnectTimers.keys()]) {
      this.cancelReconnect(accountId);
    }
    for (const entry of this.sockets.values()) {
      this.closeSocket(entry);
    }
    this.sockets.clear();
  }

  /**
   * Close one account's socket and keep it closed until an explicit {@link connect}. As in
   * {@link closeAll} there is no `logout()` and the auth state stays on disk, so that connect
   * resumes the session without a new QR. The subscriptions stay too, for the same reason.
   */
  closeConnection(accountId: string): void {
    this.ended.set(accountId, 'closed');
    this.cancelReconnect(accountId);
    const entry = this.sockets.get(accountId);
    if (entry) {
      this.closeSocket(entry);
      this.sockets.delete(accountId);
    }
    this.notify(this.connectionHandlers, accountId, { connection: 'close' });
  }

  /** Without the handlers the 'close' cannot schedule a reconnect; `end` closes locally, with no network logout. */
  private closeSocket(entry: SocketEntry): void {
    try { entry.socket.ev.removeAllListeners('connection.update'); } catch { /* best-effort */ }
    try { entry.socket.end(undefined); } catch { /* best-effort */ }
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
        this.closeSocket(entry);
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
   * a connect is in flight, its session is being cleared, its connection ended
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
      this.ended.has(accountId) ||
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
  isWired(accountId: string): boolean {
    return this.messageHandlers.has(accountId) || this.connectionHandlers.has(accountId);
  }

  hasSocket(accountId: string): boolean {
    return this.sockets.has(accountId);
  }

  /** Undefined while the account has a connection or is still trying to get one. */
  getConnectionEnd(accountId: string): ConnectionEnd | undefined {
    return this.ended.get(accountId);
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

    await this.waitUntilPairable(accountId, entry);

    if (entry.connectionStatus === 'connected') {
      throw new Error(`Account '${accountId}' is already connected.`);
    }

    // Clean phone number: remove +, spaces, dashes
    const cleaned = phoneNumber.replace(/[^0-9]/g, '');
    const code = await entry.socket.requestPairingCode(cleaned);
    return code;
  }

  /**
   * Baileys sends the request over the socket as it is: while it is still opening that throws
   * "Connection Closed", and before the handshake ends WhatsApp could not read it. The first QR is
   * the sign that an unpaired session got there. An open or a close also ends the wait: the caller
   * answers those.
   */
  private waitUntilPairable(accountId: string, entry: SocketEntry): Promise<void> {
    if (entry.lastQr !== undefined || entry.connectionStatus !== 'connecting') {
      return Promise.resolve();
    }
    const events = entry.socket.ev;
    return new Promise((resolve, reject) => {
      const onUpdate = (update: Partial<BaileysEventMap['connection.update']>) => {
        if (update.qr || update.connection === 'open' || update.connection === 'close') {
          stop();
          resolve();
        }
      };
      const timer = setTimeout(() => {
        stop();
        reject(new Error(`The connection of account '${accountId}' is not ready for pairing yet. Try again.`));
      }, PAIRING_READY_TIMEOUT_MS);
      const stop = () => {
        clearTimeout(timer);
        events.off('connection.update', onUpdate);
      };
      events.on('connection.update', onUpdate);
    });
  }

  async getGroups(accountId: string): Promise<GroupInfo[]> {
    const socket = this.getSocket(accountId);
    if (!socket) return [];
    const groups = await socket.groupFetchAllParticipating();
    const cache = this.groupMetadataFor(accountId);
    for (const metadata of Object.values(groups)) cache.set(metadata.id, metadata);
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
      this.groupMetadataFor(accountId).set(groupId, metadata);
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
   * Resolve a WhatsApp LID (e.g. "100000000000001@lid") to a phone-number JID
   * (e.g. "34600000001@s.whatsapp.net") using Baileys' built-in LID mapping store.
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
   * lost session (needs a QR), an explicit disconnect or a session reset stop the loop.
   */
  private scheduleReconnect(accountId: string, config: BaileysProviderConfig, statusCode: number | undefined): void {
    if (this.reconnectTimers.has(accountId)) {
      return;
    }
    const attempt = this.reconnectAttempts.get(accountId) ?? 0;
    this.reconnectAttempts.set(accountId, attempt + 1);
    const backoffMs = computeBackoffMs(attempt, { random: this.options.random });
    const delayMs = Math.round(statusCode === DisconnectReason.connectionReplaced
      ? Math.max(backoffMs, CONNECTION_REPLACED_MIN_DELAY_MS)
      : backoffMs);

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
    if (this.clearing.has(accountId) || this.ended.has(accountId)) {
      return;
    }
    this.sockets.delete(accountId);

    try {
      await this.connect(accountId, config);
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

