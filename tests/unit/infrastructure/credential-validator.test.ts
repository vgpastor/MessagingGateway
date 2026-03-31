import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CredentialValidator } from '../../../src/infrastructure/credential-validator.js';
import { HealthCheckerRegistry } from '../../../src/integrations/health-checker.registry.js';
import { WwebjsHealthChecker } from '../../../src/integrations/whatsapp/wwebjs-api/wwebjs.health-checker.js';
import { TelegramBotHealthChecker } from '../../../src/integrations/telegram/bot-api/telegram-bot.health-checker.js';
import { BrevoHealthChecker } from '../../../src/integrations/email/brevo/brevo.health-checker.js';
import { TwilioHealthChecker } from '../../../src/integrations/sms/twilio/twilio.health-checker.js';
import { MessageBirdHealthChecker } from '../../../src/integrations/sms/messagebird/messagebird.health-checker.js';
import type { ChannelAccount } from '../../../src/domain/accounts/channel-account.js';

function makeRegistry(): HealthCheckerRegistry {
  const registry = new HealthCheckerRegistry();
  registry.register('wwebjs-api', new WwebjsHealthChecker());
  registry.register('telegram-bot-api', new TelegramBotHealthChecker());
  registry.register('brevo', new BrevoHealthChecker());
  registry.register('twilio', new TwilioHealthChecker());
  registry.register('messagebird', new MessageBirdHealthChecker());
  return registry;
}

function makeAccount(overrides: Partial<ChannelAccount> = {}): ChannelAccount {
  return {
    id: 'wa-acme',
    alias: 'Acme WhatsApp',
    channel: 'whatsapp',
    provider: 'wwebjs-api',
    status: 'unchecked',
    identity: { channel: 'whatsapp', phoneNumber: '+34600000001' },
    credentialsRef: 'WWEBJS_ACME',
    providerConfig: { baseUrl: 'http://wwebjs-acme:3001' },
    metadata: {
      owner: 'acme-corp',
      environment: 'production',
      tags: ['support', 'acme'],
    },
    ...overrides,
  };
}

describe('CredentialValidator', () => {
  let validator: CredentialValidator;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    validator = new CredentialValidator(makeRegistry());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  // --- wwebjs-api ---

  it('should return unchecked when wwebjs API key is missing', async () => {
    const result = await validator.validate(makeAccount());

    expect(result.status).toBe('unchecked');
    expect(result.credentialsConfigured).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('should return active when wwebjs /ping responds 200', async () => {
    vi.stubEnv('WWEBJS_ACME_API_KEY', 'real-key');
    vi.mocked(fetch).mockResolvedValue(new Response('{"success":true,"message":"pong"}', { status: 200 }));

    const result = await validator.validate(makeAccount());

    expect(result.status).toBe('active');
    expect(result.credentialsConfigured).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      'http://wwebjs-acme:3001/ping',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          'x-api-key': 'real-key',
        }),
      }),
    );
  });

  it('should return auth_expired when wwebjs API responds 401', async () => {
    vi.stubEnv('WWEBJS_ACME_API_KEY', 'bad-key');
    vi.mocked(fetch).mockResolvedValue(new Response('Unauthorized', { status: 401 }));

    const result = await validator.validate(makeAccount());
    expect(result.status).toBe('auth_expired');
    expect(result.credentialsConfigured).toBe(true);
  });

  it('should use baseUrl from connection string and extract apiKey from sessionId:key format', async () => {
    vi.stubEnv('WWEBJS_ACME_API_KEY', 'user:real-key@external-host:4000');
    vi.mocked(fetch).mockResolvedValue(new Response('{"success":true,"message":"pong"}', { status: 200 }));

    const result = await validator.validate(makeAccount());

    expect(result.status).toBe('active');
    expect(fetch).toHaveBeenCalledWith(
      'http://external-host:4000/ping',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          'x-api-key': 'real-key',
        }),
      }),
    );
  });

  it('should return error when wwebjs API responds 500', async () => {
    vi.stubEnv('WWEBJS_ACME_API_KEY', 'some-key');
    vi.mocked(fetch).mockResolvedValue(new Response('Server Error', { status: 500 }));

    const result = await validator.validate(makeAccount());
    expect(result.status).toBe('error');
    expect(result.credentialsConfigured).toBe(true);
  });

  it('should return error when fetch throws (network error)', async () => {
    vi.stubEnv('WWEBJS_ACME_API_KEY', 'some-key');
    vi.mocked(fetch).mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await validator.validate(makeAccount());
    expect(result.status).toBe('error');
    expect(result.detail).toContain('ECONNREFUSED');
  });

  // --- telegram-bot-api ---

  it('should return active when Telegram getMe responds 200', async () => {
    vi.stubEnv('TG_ALERTS_TOKEN', '123456:AAF-realtoken');
    vi.mocked(fetch).mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

    const result = await validator.validate(makeAccount({
      id: 'tg-alerts-bot',
      channel: 'telegram',
      provider: 'telegram-bot-api',
      credentialsRef: 'TG_ALERTS',
      identity: { channel: 'telegram', botUsername: 'test_alerts_bot' },
      providerConfig: {},
    }));

    expect(result.status).toBe('active');
    expect(fetch).toHaveBeenCalledWith(
      'https://api.telegram.org/bot123456:AAF-realtoken/getMe',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('should return auth_expired when Telegram responds 401', async () => {
    vi.stubEnv('TG_ALERTS_TOKEN', 'bad-token');
    vi.mocked(fetch).mockResolvedValue(new Response('Unauthorized', { status: 401 }));

    const result = await validator.validate(makeAccount({
      provider: 'telegram-bot-api',
      credentialsRef: 'TG_ALERTS',
      identity: { channel: 'telegram', botUsername: 'test_alerts_bot' },
      providerConfig: {},
    }));
    expect(result.status).toBe('auth_expired');
  });

  it('should return unchecked when Telegram token is missing', async () => {
    const result = await validator.validate(makeAccount({
      provider: 'telegram-bot-api',
      credentialsRef: 'TG_ALERTS',
      identity: { channel: 'telegram', botUsername: 'test_alerts_bot' },
      providerConfig: {},
    }));
    expect(result.status).toBe('unchecked');
    expect(result.credentialsConfigured).toBe(false);
  });

  // --- brevo ---

  it('should return active when Brevo responds 200', async () => {
    vi.stubEnv('BREVO_MAIN_API_KEY', 'xkeysib-real');
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }));

    const result = await validator.validate(makeAccount({
      provider: 'brevo',
      credentialsRef: 'BREVO_MAIN',
      identity: { channel: 'email', address: 'noreply@test.com' },
      providerConfig: {},
    }));

    expect(result.status).toBe('active');
    expect(fetch).toHaveBeenCalledWith(
      'https://api.brevo.com/v3/account',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  // --- twilio ---

  it('should return active when Twilio responds 200', async () => {
    vi.stubEnv('TWILIO_DEFAULT_AUTH_TOKEN', 'real-auth-token');
    vi.stubEnv('TWILIO_DEFAULT_ACCOUNT_SID', 'AC1234567890');
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }));

    const result = await validator.validate(makeAccount({
      provider: 'twilio',
      credentialsRef: 'TWILIO_DEFAULT',
      identity: { channel: 'sms', phoneNumber: '+34900000001' },
      providerConfig: {},
    }));

    expect(result.status).toBe('active');
    expect(fetch).toHaveBeenCalledWith(
      'https://api.twilio.com/2010-04-01/Accounts/AC1234567890.json',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('should return unchecked when Twilio account SID is missing', async () => {
    vi.stubEnv('TWILIO_DEFAULT_AUTH_TOKEN', 'real-auth-token');

    const result = await validator.validate(makeAccount({
      provider: 'twilio',
      credentialsRef: 'TWILIO_DEFAULT',
      identity: { channel: 'sms', phoneNumber: '+34900000001' },
      providerConfig: {},
    }));
    expect(result.status).toBe('unchecked');
    expect(result.credentialsConfigured).toBe(false);
  });

  // --- messagebird ---

  it('should return active when MessageBird responds 200', async () => {
    vi.stubEnv('MESSAGEBIRD_DEFAULT_API_KEY', 'real-api-key');
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }));

    const result = await validator.validate(makeAccount({
      provider: 'messagebird',
      credentialsRef: 'MESSAGEBIRD_DEFAULT',
      identity: { channel: 'sms', phoneNumber: '+34900000002' },
      providerConfig: {},
    }));

    expect(result.status).toBe('active');
    expect(fetch).toHaveBeenCalledWith(
      'https://rest.messagebird.com/balance',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  // --- no health checker registered ---

  it('should return unchecked for unregistered provider', async () => {
    const result = await validator.validate(makeAccount({
      provider: 'evolution-api' as ChannelAccount['provider'],
    }));
    expect(result.status).toBe('unchecked');
    expect(result.detail).toContain('No health checker');
  });
});

describe('CredentialValidator.validateAll', () => {
  let validator: CredentialValidator;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    validator = new CredentialValidator(makeRegistry());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('should skip accounts that are not unchecked', async () => {
    const account = makeAccount({ status: 'suspended' });
    const results = await validator.validateAll([account]);

    expect(results[0].status).toBe('suspended');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('should validate all unchecked accounts in parallel', async () => {
    vi.stubEnv('WWEBJS_ACME_API_KEY', 'key1');
    vi.stubEnv('TG_ALERTS_TOKEN', 'token1');
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }));

    const accounts = [
      makeAccount(),
      makeAccount({
        id: 'tg-alerts-bot',
        channel: 'telegram',
        provider: 'telegram-bot-api',
        credentialsRef: 'TG_ALERTS',
        identity: { channel: 'telegram', botUsername: 'test_alerts_bot' },
        providerConfig: {},
      }),
    ];

    const results = await validator.validateAll(accounts);

    expect(results[0].status).toBe('active');
    expect(results[1].status).toBe('active');
    // wwebjs: /ping + /session/info (identity discovery), telegram: /getMe
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
