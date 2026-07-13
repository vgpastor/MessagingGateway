import type { ConnectionManagerPort, ConnectionInfo } from '../../../core/accounts/connection-manager.port.js';
import type { MattermostSocketManager } from './mattermost.socket-manager.js';

export class MattermostConnectionManager implements ConnectionManagerPort {
  constructor(private readonly socketManager: MattermostSocketManager) {}

  supports(provider: string): boolean {
    return provider === 'mattermost';
  }

  async connect(accountId: string, providerConfig: Record<string, unknown>): Promise<void> {
    if (this.socketManager.hasSocket(accountId)) return;

    const serverUrl = providerConfig.serverUrl as string;
    const token = providerConfig.token as string;
    let botUserId = (providerConfig.botUserId as string) ?? '';

    // Resolve bot user ID from the token if not provided
    if (!botUserId && token && serverUrl) {
      try {
        const resp = await fetch(`${serverUrl}/api/v4/users/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (resp.ok) {
          const me = await resp.json() as { id: string };
          botUserId = me.id;
        }
      } catch {
        // Non-blocking: bot messages won't be filtered but won't crash
      }
    }

    if (!serverUrl || !token) {
      throw new Error(`Mattermost connection requires serverUrl and token in providerConfig for account '${accountId}'`);
    }

    await this.socketManager.connect(accountId, serverUrl, token, botUserId);
  }

  getConnectionInfo(accountId: string): ConnectionInfo {
    return {
      status: this.socketManager.getConnectionStatus(accountId),
    };
  }

  hasConnection(accountId: string): boolean {
    return this.socketManager.hasSocket(accountId);
  }

  async disconnect(accountId: string): Promise<void> {
    await this.socketManager.disconnect(accountId);
  }
}
