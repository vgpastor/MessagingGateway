import type { ChannelAccount } from '../domain/accounts/channel-account.js';
import type { ValidationResult } from '../domain/messaging/provider-health.port.js';
import type { HealthCheckerRegistry } from '../adapters/health-checker.registry.js';

export class CredentialValidator {
  constructor(private readonly registry: HealthCheckerRegistry) {}

  async validate(account: ChannelAccount): Promise<ValidationResult> {
    const checker = this.registry.get(account.provider);
    if (!checker) {
      return { status: 'unchecked', credentialsConfigured: false, detail: `No health checker for provider '${account.provider}'` };
    }

    try {
      return await checker.validate(account);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { status: 'error', credentialsConfigured: false, detail: message };
    }
  }

  async validateAll(accounts: ChannelAccount[]): Promise<ChannelAccount[]> {
    const results = await Promise.allSettled(
      accounts.map(async (account) => {
        if (account.status !== 'unchecked') return account;
        const result = await this.validate(account);
        return { ...account, status: result.status };
      }),
    );

    return results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      const original = accounts[i]!;
      return { ...original, status: 'error' as const };
    });
  }
}
