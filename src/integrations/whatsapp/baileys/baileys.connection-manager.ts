import type { ConnectionManagerPort, ConnectionInfo, PairingCodeCapable } from '../../../core/accounts/connection-manager.port.js';
import type { BaileysSocketManager } from './baileys-socket.manager.js';
import { parseBaileysConfig } from './baileys.types.js';

export class BaileysConnectionManager implements ConnectionManagerPort, PairingCodeCapable {
  constructor(private readonly socketManager: BaileysSocketManager) {}

  supports(provider: string): boolean {
    return provider === 'baileys';
  }

  async connect(accountId: string, providerConfig: Record<string, unknown>): Promise<void> {
    if (this.socketManager.hasSocket(accountId)) return;
    const config = parseBaileysConfig(providerConfig);
    await this.socketManager.connect(accountId, config);
  }

  getConnectionInfo(accountId: string): ConnectionInfo {
    return {
      status: this.socketManager.getConnectionStatus(accountId),
      qr: this.socketManager.getLastQr(accountId),
    };
  }

  hasConnection(accountId: string): boolean {
    return this.socketManager.hasSocket(accountId);
  }

  async requestPairingCode(accountId: string, phoneNumber: string): Promise<string> {
    return this.socketManager.requestPairingCode(accountId, phoneNumber);
  }

  async disconnect(accountId: string): Promise<void> {
    await this.socketManager.disconnect(accountId);
  }
}
