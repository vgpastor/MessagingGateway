import type { ChannelAccount } from '../../../core/accounts/channel-account.js';
import type { ProviderHealthChecker, ValidationResult } from '../../../core/messaging/provider-health.port.js';
import { fetchWithTimeout } from '../../shared/http.js';
import { parseCredential } from './parse-credential.js';

export class WwebjsHealthChecker implements ProviderHealthChecker {
  async validate(account: ChannelAccount): Promise<ValidationResult> {
    const raw = account.credentials;
    if (!raw) {
      return { status: 'unchecked', credentialsConfigured: false, detail: 'Missing API key' };
    }

    const parsed = parseCredential(raw);

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
      // Try to discover phone number from session info
      const discovered = await this.discoverIdentity(baseUrl, headers, account);
      return { status: 'active', credentialsConfigured: true, ...discovered };
    }
    if (response.status === 401 || response.status === 403) {
      return { status: 'auth_expired', credentialsConfigured: true, detail: `HTTP ${response.status}` };
    }
    return { status: 'error', credentialsConfigured: true, detail: `HTTP ${response.status}` };
  }

  private async discoverIdentity(
    baseUrl: string,
    headers: Record<string, string>,
    account: ChannelAccount,
  ): Promise<Pick<ValidationResult, 'discoveredIdentity'>> {
    try {
      const sessionId = (account.providerConfig['sessionId'] as string) ?? 'default';
      const res = await fetchWithTimeout(`${baseUrl}/session/info/${sessionId}`, { method: 'GET', headers });
      if (!res.ok) return {};

      const info = await res.json() as Record<string, unknown>;
      const me = info['me'] as Record<string, string> | undefined;
      const phoneNumber = me?.['user'] ? `+${me['user']}` : undefined;
      if (phoneNumber) {
        return {
          discoveredIdentity: { channel: 'whatsapp', phoneNumber, wid: me?.['_serialized'] },
        };
      }
    } catch {
      // Identity discovery is best-effort
    }
    return {};
  }
}
