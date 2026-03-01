import type { ChannelAccount } from '../../../domain/accounts/channel-account.js';
import type { ProviderHealthChecker, ValidationResult } from '../../../domain/messaging/provider-health.port.js';
import { resolveProviderCredential } from '../../../infrastructure/config/env.config.js';
import { fetchWithTimeout } from '../../shared/http.js';

export class TelegramBotHealthChecker implements ProviderHealthChecker {
  async validate(account: ChannelAccount): Promise<ValidationResult> {
    const token = resolveProviderCredential(account.credentialsRef, account.provider);
    if (!token) {
      return { status: 'unchecked', credentialsConfigured: false, detail: 'Missing bot token' };
    }

    const response = await fetchWithTimeout(
      `https://api.telegram.org/bot${token}/getMe`,
      { method: 'GET' },
    );

    if (response.ok) {
      // Extract bot identity from getMe response
      try {
        const body = await response.json() as { ok: boolean; result?: { id: number; username: string } };
        if (body.ok && body.result) {
          return {
            status: 'active',
            credentialsConfigured: true,
            discoveredIdentity: {
              channel: 'telegram',
              botId: String(body.result.id),
              botUsername: body.result.username,
            },
          };
        }
      } catch {
        // Identity discovery is best-effort
      }
      return { status: 'active', credentialsConfigured: true };
    }
    if (response.status === 401) {
      return { status: 'auth_expired', credentialsConfigured: true, detail: 'Invalid bot token' };
    }
    return { status: 'error', credentialsConfigured: true, detail: `HTTP ${response.status}` };
  }
}
