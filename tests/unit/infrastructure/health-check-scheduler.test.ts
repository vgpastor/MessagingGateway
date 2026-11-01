import { describe, it, expect, vi, afterEach } from 'vitest';
import type { AccountStatus, ChannelAccount } from '../../../src/core/accounts/channel-account.js';
import type { ValidationResult } from '../../../src/core/messaging/provider-health.port.js';
import { InMemoryAccountRepository } from '../../../src/infrastructure/config/in-memory-account.repository.js';
import { HealthCheckScheduler } from '../../../src/infrastructure/health-check-scheduler.js';
import type { CredentialValidator } from '../../../src/infrastructure/credential-validator.js';

const INTERVAL_MS = 1000;

function setup(status: AccountStatus, verdict: ValidationResult) {
  const repository = new InMemoryAccountRepository([{ id: 'wa-1', status, identity: { channel: 'whatsapp', phoneNumber: '+34600000001' }, metadata: { tags: [] } } as unknown as ChannelAccount]);
  const validator = { validate: vi.fn(async () => verdict) } as unknown as CredentialValidator;
  const scheduler = new HealthCheckScheduler(repository, validator, { intervalMs: INTERVAL_MS });
  const current = () => repository.findById('wa-1');
  return { repository, scheduler, current, validator };
}

const active: ValidationResult = { status: 'active', credentialsConfigured: true };

describe('HealthCheckScheduler', () => {
  afterEach(() => vi.useRealTimers());

  it('writes the verdict of a check', async () => {
    const { scheduler, current } = setup('unchecked', active);

    await scheduler.checkAccount('wa-1');

    expect((await current())?.status).toBe('active');
  });

  it('checkAccount does not overwrite a suspended account', async () => {
    const { scheduler, current } = setup('suspended', active);

    await scheduler.checkAccount('wa-1');

    expect((await current())?.status).toBe('suspended');
  });

  it('the periodic round does not overwrite a suspended account', async () => {
    vi.useFakeTimers();
    const { scheduler, current, validator } = setup('suspended', active);

    scheduler.start();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    scheduler.stop();

    expect(validator.validate).toHaveBeenCalledTimes(1);
    expect((await current())?.status).toBe('suspended');
  });

  it('an account suspended while its check was running stays suspended', async () => {
    const { repository, current, validator, scheduler } = setup('active', active);
    vi.mocked(validator.validate).mockImplementation(async () => {
      await repository.update('wa-1', { status: 'suspended' });
      return active;
    });

    await scheduler.checkAccount('wa-1');

    expect((await current())?.status).toBe('suspended');
  });

  it('an account deleted while its check was running is not touched', async () => {
    const { repository, current, validator, scheduler } = setup('active', active);
    vi.mocked(validator.validate).mockImplementation(async () => {
      await repository.remove('wa-1');
      return active;
    });

    await scheduler.checkAccount('wa-1');

    expect(await current()).toBeUndefined();
  });

  it('merges the identity a check discovered', async () => {
    const { scheduler, current } = setup('active', { ...active, discoveredIdentity: { wid: '34600000001@c.us' } as never });

    await scheduler.checkAccount('wa-1');

    expect((await current())?.identity).toMatchObject({ phoneNumber: '+34600000001', wid: '34600000001@c.us' });
  });
});
