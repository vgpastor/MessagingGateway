import type { ChannelAccountRepository } from '../core/accounts/channel-account.repository.js';
import type { AccountIdentity } from '../core/accounts/account-identity.js';
import type { CredentialValidator } from './credential-validator.js';
import { getLogger } from '../core/logger/logger.port.js';

export interface HealthCheckSchedulerConfig {
  intervalMs: number;
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class HealthCheckScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly accountRepository: ChannelAccountRepository,
    private readonly credentialValidator: CredentialValidator,
    private readonly config: HealthCheckSchedulerConfig = { intervalMs: DEFAULT_INTERVAL_MS },
  ) {}

  start(): void {
    if (this.timer) return;

    getLogger().info('Health check scheduler started', { intervalSeconds: this.config.intervalMs / 1000 });
    this.timer = setInterval(() => {
      void this.runAll();
    }, this.config.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      getLogger().info('Health check scheduler stopped');
    }
  }

  async checkAccount(accountId: string): Promise<void> {
    const account = await this.accountRepository.findById(accountId);
    if (!account) return;

    const result = await this.credentialValidator.validate(account);

    await this.accountRepository.update(account.id, {
      status: result.status,
      ...(result.discoveredIdentity
        ? { identity: { ...account.identity, ...result.discoveredIdentity } as AccountIdentity }
        : {}),
    });
  }

  private async runAll(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const accounts = await this.accountRepository.findAll();
      const results = await Promise.allSettled(
        accounts.map(async (account) => {
          const result = await this.credentialValidator.validate(account);
          await this.accountRepository.update(account.id, {
            status: result.status,
            ...(result.discoveredIdentity
              ? { identity: { ...account.identity, ...result.discoveredIdentity } as AccountIdentity }
              : {}),
          });
        }),
      );

      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed > 0) {
        getLogger().warn('Periodic health check: some checks failed', { failed, total: accounts.length });
      }
    } catch (err) {
      getLogger().warn('Periodic health check error', { error: (err as Error).message });
    } finally {
      this.running = false;
    }
  }
}
