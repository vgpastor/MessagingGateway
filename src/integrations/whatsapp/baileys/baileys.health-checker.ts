import { existsSync } from 'node:fs';
import type { ChannelAccount } from '../../../domain/accounts/channel-account.js';
import type { ProviderHealthChecker, ValidationResult } from '../../../domain/messaging/provider-health.port.js';
import { baileysSocketManager } from './baileys-socket.manager.js';
import { parseBaileysConfig } from './baileys.types.js';

export class BaileysHealthChecker implements ProviderHealthChecker {
  async validate(account: ChannelAccount): Promise<ValidationResult> {
    const config = parseBaileysConfig(account.providerConfig);
    const authDir = baileysSocketManager.resolveAuthDir(account.id, config);
    const hasAuthFiles = existsSync(authDir);

    if (baileysSocketManager.isConnected(account.id)) {
      return {
        status: 'active',
        credentialsConfigured: true,
        discoveredIdentity: {
          channel: 'whatsapp',
          phoneNumber: account.identity?.channel === 'whatsapp' ? account.identity.phoneNumber : undefined,
        },
      };
    }

    if (hasAuthFiles) {
      return {
        status: 'auth_expired',
        credentialsConfigured: true,
        detail: 'Auth files exist but socket is not connected. Connection will be established on startup.',
      };
    }

    return {
      status: 'unchecked',
      credentialsConfigured: false,
      detail: 'No auth files found. QR code scan required on first connection.',
    };
  }
}
