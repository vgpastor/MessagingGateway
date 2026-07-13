import type { ChannelAccount } from '../../../core/accounts/channel-account.js';
import type { ProviderHealthChecker, ValidationResult } from '../../../core/messaging/provider-health.port.js';
import { fetchWithTimeout } from '../../shared/http.js';
import type { MattermostUser } from '../mattermost-channel.types.js';

export class MattermostHealthChecker implements ProviderHealthChecker {
  async validate(account: ChannelAccount): Promise<ValidationResult> {
    const token = account.credentials;
    const serverUrl = account.providerConfig.serverUrl as string | undefined;

    if (!token || !serverUrl) {
      return { status: 'unchecked', credentialsConfigured: false, detail: 'Missing bot token or serverUrl' };
    }

    const response = await fetchWithTimeout(
      `${serverUrl}/api/v4/users/me`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    if (response.ok) {
      try {
        const user = await response.json() as MattermostUser;
        return {
          status: 'active',
          credentialsConfigured: true,
          discoveredIdentity: {
            channel: 'mattermost',
            botId: user.id,
            botUsername: user.username,
          },
        };
      } catch {
        return { status: 'active', credentialsConfigured: true };
      }
    }

    if (response.status === 401 || response.status === 403) {
      return { status: 'auth_expired', credentialsConfigured: true, detail: 'Invalid bot token' };
    }

    return { status: 'error', credentialsConfigured: true, detail: `HTTP ${response.status}` };
  }
}
