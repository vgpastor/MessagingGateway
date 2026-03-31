import type { ConnectionManagerPort, ConnectionInfo } from '../../../domain/accounts/connection-manager.port.js';
import { baileysSocketManager } from './baileys-socket.manager.js';
import { parseBaileysConfig } from './baileys.types.js';

export class BaileysConnectionManager implements ConnectionManagerPort {
  supports(provider: string): boolean {
    return provider === 'baileys';
  }

  async connect(accountId: string, providerConfig: Record<string, unknown>): Promise<void> {
    if (baileysSocketManager.hasSocket(accountId)) return;
    const config = parseBaileysConfig(providerConfig);
    await baileysSocketManager.connect(accountId, config);
  }

  getConnectionInfo(accountId: string): ConnectionInfo {
    return {
      status: baileysSocketManager.getConnectionStatus(accountId),
      qr: baileysSocketManager.getLastQr(accountId),
    };
  }

  hasConnection(accountId: string): boolean {
    return baileysSocketManager.hasSocket(accountId);
  }

  async requestPairingCode(accountId: string, phoneNumber: string): Promise<string> {
    return baileysSocketManager.requestPairingCode(accountId, phoneNumber);
  }

  async disconnect(accountId: string): Promise<void> {
    await baileysSocketManager.disconnect(accountId);
  }
}
