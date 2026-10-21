import { existsSync } from 'node:fs';
import type { ChannelAccount } from '../../../core/accounts/channel-account.js';
import type { ProviderHealthChecker, ValidationResult } from '../../../core/messaging/provider-health.port.js';
import type { BaileysSocketManager } from './baileys-socket.manager.js';
import { parseBaileysConfig, type BaileysProviderConfig } from './baileys.types.js';
import { getLogger } from '../../../core/logger/logger.port.js';

export class BaileysHealthChecker implements ProviderHealthChecker {
  constructor(private readonly socketManager: BaileysSocketManager) {}
  async validate(account: ChannelAccount): Promise<ValidationResult> {
    const config = parseBaileysConfig(account.providerConfig);
    const authDir = this.socketManager.resolveAuthDir(account.id, config);
    const hasAuthFiles = existsSync(authDir);

    if (this.socketManager.isConnected(account.id)) {
      return {
        status: 'active',
        credentialsConfigured: true,
        discoveredIdentity: {
          channel: 'whatsapp',
          phoneNumber: account.identity?.channel === 'whatsapp' ? account.identity.phoneNumber : undefined,
        },
      };
    }

    this.reconnectIfNeeded(account, config);

    if (hasAuthFiles) {
      return {
        status: 'auth_expired',
        credentialsConfigured: true,
        detail: 'Auth files exist but socket is not connected. Reconnection in progress.',
      };
    }

    return {
      status: 'unchecked',
      credentialsConfigured: false,
      detail: 'No auth files found. QR code scan required on first connection.',
    };
  }

  /**
   * Safety net behind the socket manager's own backoff loop: an account that
   * ended up with no socket (a failed startup connect, a lost entry) is brought
   * back on the next periodic check. The manager decides whether it is safe
   * (not logged out, nothing already pending), so this never stacks reconnects.
   * Suspended accounts are left alone.
   */
  private reconnectIfNeeded(account: ChannelAccount, config: BaileysProviderConfig): void {
    if (account.status === 'suspended') return;
    try {
      this.socketManager.ensureConnected(account.id, config);
    } catch (err) {
      getLogger().warn('Health check could not trigger a reconnect', { provider: 'baileys', accountId: account.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
}
