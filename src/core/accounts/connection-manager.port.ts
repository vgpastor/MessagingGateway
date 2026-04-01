/**
 * Generic port for providers that manage their own connection lifecycle
 * (e.g. Baileys with QR/pairing code auth).
 *
 * Providers that use external API keys don't need this — only those
 * that require an interactive connection flow.
 */

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

export interface ConnectionInfo {
  status: ConnectionStatus;
  /** QR code data string (render with a QR library) */
  qr?: string;
}

export interface ConnectionManagerPort {
  /** Whether this manager handles the given provider type */
  supports(provider: string): boolean;

  /** Start the connection process (e.g. open WebSocket, generate QR) */
  connect(accountId: string, providerConfig: Record<string, unknown>): Promise<void>;

  /** Get current connection info (status + QR if available) */
  getConnectionInfo(accountId: string): ConnectionInfo;

  /** Whether a connection exists (connected or connecting) */
  hasConnection(accountId: string): boolean;

  /** Disconnect and clear session */
  disconnect(accountId: string): Promise<void>;
}

export interface PairingCodeCapable {
  requestPairingCode(accountId: string, phoneNumber: string): Promise<string>;
}
