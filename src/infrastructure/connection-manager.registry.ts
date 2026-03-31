import type { ConnectionManagerPort, ConnectionInfo } from '../domain/accounts/connection-manager.port.js';

/**
 * Registry that delegates to the correct ConnectionManagerPort based on provider type.
 * Providers that don't need connection management (API-key based) simply won't have
 * a registered manager — the API will return { status: 'not_applicable' } for them.
 */
export class ConnectionManagerRegistry {
  private managers: ConnectionManagerPort[] = [];

  register(manager: ConnectionManagerPort): void {
    this.managers.push(manager);
  }

  findFor(provider: string): ConnectionManagerPort | undefined {
    return this.managers.find((m) => m.supports(provider));
  }

  getConnectionInfo(provider: string, accountId: string): ConnectionInfo & { managed: boolean } {
    const manager = this.findFor(provider);
    if (!manager) {
      return { managed: false, status: 'disconnected' };
    }
    return { managed: true, ...manager.getConnectionInfo(accountId) };
  }
}
