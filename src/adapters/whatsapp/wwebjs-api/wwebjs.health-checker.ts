import type { ChannelAccount } from '../../../domain/accounts/channel-account.js';
import type { ProviderHealthChecker, ValidationResult } from '../../../domain/messaging/provider-health.port.js';
import { resolveProviderCredentialParsed } from '../../../infrastructure/config/env.config.js';
import { fetchWithTimeout } from '../../shared/http.js';

export class WwebjsHealthChecker implements ProviderHealthChecker {
  async validate(account: ChannelAccount): Promise<ValidationResult> {
    const parsed = resolveProviderCredentialParsed(account.credentialsRef, account.provider);
    if (!parsed) {
      return { status: 'unchecked', credentialsConfigured: false, detail: 'Missing API key' };
    }

    // Extract actual API key (strip sessionId: prefix if present)
    const rawApiKey = parsed.apiKey;
    const colonIdx = rawApiKey.indexOf(':');
    const apiKey = colonIdx !== -1 ? rawApiKey.substring(colonIdx + 1) : rawApiKey;

    const configBaseUrl = (account.providerConfig['baseUrl'] as string | undefined) ?? 'http://localhost:3001';
    const baseUrl = parsed.baseUrl ?? configBaseUrl;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['x-api-key'] = apiKey;

    const response = await fetchWithTimeout(`${baseUrl}/ping`, { method: 'GET', headers });

    if (response.ok) {
      return { status: 'active', credentialsConfigured: true };
    }
    if (response.status === 401 || response.status === 403) {
      return { status: 'auth_expired', credentialsConfigured: true, detail: `HTTP ${response.status}` };
    }
    return { status: 'error', credentialsConfigured: true, detail: `HTTP ${response.status}` };
  }
}
