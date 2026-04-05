/**
 * Generic port for providers that maintain persistent socket connections.
 * Implemented by BaileysSocketManager, and future providers like
 * TelegramLongPollManager, SignalSocketManager, etc.
 *
 * Each provider has its own socket type (WASocket, TelegramClient, etc.)
 * but they all share this lifecycle interface.
 */

import type { GroupInfo } from '../groups/group.types.js';
import type { ConnectionStatus } from '../accounts/connection-manager.port.js';

export type { ConnectionStatus };

export type MessageHandler<TEvent = unknown> = (event: TEvent) => Promise<void> | void;
export type ConnectionHandler<TUpdate = unknown> = (update: TUpdate) => void;

export interface SocketManagerPort<TConfig = Record<string, unknown>> {
  /** Connect an account with provider-specific config */
  connect(accountId: string, config: TConfig): Promise<void>;

  /** Disconnect and clean up an account's connection */
  disconnect(accountId: string): Promise<void>;

  /** Check if account has an active connection */
  isConnected(accountId: string): boolean;

  /** Check if account has any socket (connected or connecting) */
  hasSocket(accountId: string): boolean;

  /** Get current connection status */
  getConnectionStatus(accountId: string): ConnectionStatus;

  /** Get last QR code or auth challenge (if applicable) */
  getLastQr(accountId: string): string | undefined;

  /** Register a handler for inbound messages */
  onMessage(accountId: string, handler: MessageHandler): void;

  /** Register a handler for connection state changes */
  onConnectionUpdate(accountId: string, handler: ConnectionHandler): void;

  /** List all groups the account participates in */
  getGroups?(accountId: string): Promise<GroupInfo[]>;

  /** Get metadata for a specific group */
  getGroupInfo?(accountId: string, groupId: string): Promise<GroupInfo | undefined>;
}
