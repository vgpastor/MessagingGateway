import type { ChannelAccount } from '../../../domain/accounts/channel-account.js';
import type { ProviderHealthChecker, ValidationResult } from '../../../domain/messaging/provider-health.port.js';
import { resolveProviderCredential } from '../../../infrastructure/config/env.config.js';
import { fetchWithTimeout } from '../../shared/http.js';

export class BrevoHealthChecker implements ProviderHealthChecker {
  async validate(account: ChannelAccount): Promise<ValidationResult> {
    const apiKey = resolveProviderCredential(account.credentialsRef, account.provider, account.credentials);
    if (!apiKey) {
      return { status: 'unchecked', credentialsConfigured: false, detail: 'Missing API key' };
    }

    const response = await fetchWithTimeout('https://api.brevo.com/v3/account', {
      method: 'GET',
      headers: { 'api-key': apiKey, 'Accept': 'application/json' },
    });

    if (response.ok) {
      return { status: 'active', credentialsConfigured: true };
    }
    if (response.status === 401) {
      return { status: 'auth_expired', credentialsConfigured: true, detail: 'Invalid API key' };
    }
    return { status: 'error', credentialsConfigured: true, detail: `HTTP ${response.status}` };
  }
}
