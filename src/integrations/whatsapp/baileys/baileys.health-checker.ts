import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ChannelAccount } from '../../../core/accounts/channel-account.js';
import type { ProviderHealthChecker, ValidationResult } from '../../../core/messaging/provider-health.port.js';
import type { BaileysSocketManager } from './baileys-socket.manager.js';
import { parseBaileysConfig, type BaileysProviderConfig } from './baileys.types.js';
import { getLogger } from '../../../core/logger/logger.port.js';

export class BaileysHealthChecker implements ProviderHealthChecker {
  constructor(private readonly socketManager: BaileysSocketManager) {}
  async validate(account: ChannelAccount): Promise<ValidationResult> {
    const config = parseBaileysConfig(account.providerConfig);
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

    if (this.socketManager.getConnectionEnd(account.id)) {
      return {
        status: 'auth_expired',
        credentialsConfigured: true,
        detail: `Not connected and not trying to: re-pair it with POST /api/v1/accounts/${account.id}/reset.`,
      };
    }

    if (this.socketManager.getLastQr(account.id)) {
      return {
        status: 'unchecked',
        credentialsConfigured: false,
        detail: 'Waiting for the QR code to be scanned.',
      };
    }

    // The auth dir alone says nothing: it exists from the first attempt to connect.
    const authDir = this.socketManager.resolveAuthDir(account.id, config);
    if (!existsSync(join(authDir, 'creds.json'))) {
      return {
        status: 'unchecked',
        credentialsConfigured: false,
        detail: 'No stored session. QR code scan required on first connection.',
      };
    }

    // A connection that is down for now settles nothing about the session.
    return {
      status: account.status,
      credentialsConfigured: true,
      detail: 'Stored session found, not connected right now.',
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
