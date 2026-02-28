import type { ChannelAccount } from '../../../domain/accounts/channel-account.js';
import type { ProviderHealthChecker, ValidationResult } from '../../../domain/messaging/provider-health.port.js';
import { resolveProviderCredential } from '../../../infrastructure/config/env.config.js';
import { fetchWithTimeout } from '../../shared/http.js';

export class WwebjsHealthChecker implements ProviderHealthChecker {
  async validate(account: ChannelAccount): Promise<ValidationResult> {
    const apiKey = resolveProviderCredential(account.credentialsRef, account.provider);
    if (!apiKey) {
      return { status: 'unchecked', credentialsConfigured: false, detail: 'Missing API key' };
    }

    const baseUrl = (account.providerConfig['baseUrl'] as string | undefined) ?? 'http://localhost:3001';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const response = await fetchWithTimeout(`${baseUrl}/api/status`, { method: 'GET', headers });

    if (response.ok) {
      return { status: 'active', credentialsConfigured: true };
    }
    if (response.status === 401 || response.status === 403) {
      return { status: 'auth_expired', credentialsConfigured: true, detail: `HTTP ${response.status}` };
    }
    return { status: 'error', credentialsConfigured: true, detail: `HTTP ${response.status}` };
  }
}
