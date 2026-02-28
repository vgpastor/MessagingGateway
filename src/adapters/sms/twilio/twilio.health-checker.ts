import type { ChannelAccount } from '../../../domain/accounts/channel-account.js';
import type { ProviderHealthChecker, ValidationResult } from '../../../domain/messaging/provider-health.port.js';
import { resolveProviderCredential, resolveCredential } from '../../../infrastructure/config/env.config.js';
import { fetchWithTimeout } from '../../shared/http.js';

export class TwilioHealthChecker implements ProviderHealthChecker {
  async validate(account: ChannelAccount): Promise<ValidationResult> {
    const authToken = resolveProviderCredential(account.credentialsRef, account.provider);
    const accountSid = resolveCredential(account.credentialsRef, 'ACCOUNT_SID');
    if (!authToken || !accountSid) {
      return { status: 'unchecked', credentialsConfigured: false, detail: 'Missing account SID or auth token' };
    }

    const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const response = await fetchWithTimeout(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}.json`,
      {
        method: 'GET',
        headers: { 'Authorization': `Basic ${credentials}` },
      },
    );

    if (response.ok) {
      return { status: 'active', credentialsConfigured: true };
    }
    if (response.status === 401) {
      return { status: 'auth_expired', credentialsConfigured: true, detail: 'Invalid credentials' };
    }
    return { status: 'error', credentialsConfigured: true, detail: `HTTP ${response.status}` };
  }
}
