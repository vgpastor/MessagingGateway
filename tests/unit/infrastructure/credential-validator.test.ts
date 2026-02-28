import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateAccount, validateAllAccounts } from '../../../src/infrastructure/credential-validator.js';
import type { ChannelAccount } from '../../../src/domain/accounts/channel-account.js';

function makeAccount(overrides: Partial<ChannelAccount> = {}): ChannelAccount {
  return {
    id: 'wa-samur',
    alias: 'SAMUR WhatsApp',
    channel: 'whatsapp',
    provider: 'wwebjs-api',
    status: 'unchecked',
    identity: { channel: 'whatsapp', phoneNumber: '+34600000001' },
    credentialsRef: 'WWEBJS_SAMUR',
    providerConfig: { baseUrl: 'http://wwebjs-samur:3001' },
    metadata: {
      owner: 'global-emergency',
      environment: 'production',
      tags: ['emergency', 'samur'],
    },
    ...overrides,
  };
}

describe('validateAccount', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  // --- wwebjs-api ---

  it('should return unchecked when wwebjs API key is missing', async () => {
    const account = makeAccount();
    const result = await validateAccount(account);

    expect(result.status).toBe('unchecked');
    expect(result.credentialsConfigured).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('should return active when wwebjs API responds 200', async () => {
    vi.stubEnv('WWEBJS_SAMUR_API_KEY', 'real-key');
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }));

    const account = makeAccount();
    const result = await validateAccount(account);

    expect(result.status).toBe('active');
    expect(result.credentialsConfigured).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      'http://wwebjs-samur:3001/api/status',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('should return auth_expired when wwebjs API responds 401', async () => {
    vi.stubEnv('WWEBJS_SAMUR_API_KEY', 'bad-key');
    vi.mocked(fetch).mockResolvedValue(new Response('Unauthorized', { status: 401 }));

    const account = makeAccount();
    const result = await validateAccount(account);

    expect(result.status).toBe('auth_expired');
    expect(result.credentialsConfigured).toBe(true);
  });

  it('should return error when wwebjs API responds 500', async () => {
    vi.stubEnv('WWEBJS_SAMUR_API_KEY', 'some-key');
    vi.mocked(fetch).mockResolvedValue(new Response('Server Error', { status: 500 }));

    const account = makeAccount();
    const result = await validateAccount(account);

    expect(result.status).toBe('error');
    expect(result.credentialsConfigured).toBe(true);
  });

  it('should return error when wwebjs fetch throws (network error)', async () => {
    vi.stubEnv('WWEBJS_SAMUR_API_KEY', 'some-key');
    vi.mocked(fetch).mockRejectedValue(new Error('ECONNREFUSED'));

    const account = makeAccount();
    const result = await validateAccount(account);

    expect(result.status).toBe('error');
    expect(result.detail).toContain('ECONNREFUSED');
  });

  // --- telegram-bot-api ---

  it('should return active when Telegram getMe responds 200', async () => {
    vi.stubEnv('TG_DEAMAP_ALERTS_TOKEN', '123456:AAF-realtoken');
    vi.mocked(fetch).mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

    const account = makeAccount({
      id: 'tg-deamap-bot',
      channel: 'telegram',
      provider: 'telegram-bot-api',
      credentialsRef: 'TG_DEAMAP_ALERTS',
      identity: { channel: 'telegram', botUsername: 'deamap_alerts_bot' },
      providerConfig: {},
    });
    const result = await validateAccount(account);

    expect(result.status).toBe('active');
    expect(fetch).toHaveBeenCalledWith(
      'https://api.telegram.org/bot123456:AAF-realtoken/getMe',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('should return auth_expired when Telegram responds 401', async () => {
    vi.stubEnv('TG_DEAMAP_ALERTS_TOKEN', 'bad-token');
    vi.mocked(fetch).mockResolvedValue(new Response('Unauthorized', { status: 401 }));

    const account = makeAccount({
      id: 'tg-deamap-bot',
      channel: 'telegram',
      provider: 'telegram-bot-api',
      credentialsRef: 'TG_DEAMAP_ALERTS',
      identity: { channel: 'telegram', botUsername: 'deamap_alerts_bot' },
      providerConfig: {},
    });
    const result = await validateAccount(account);

    expect(result.status).toBe('auth_expired');
  });

  it('should return unchecked when Telegram token is missing', async () => {
    const account = makeAccount({
      id: 'tg-deamap-bot',
      channel: 'telegram',
      provider: 'telegram-bot-api',
      credentialsRef: 'TG_DEAMAP_ALERTS',
      identity: { channel: 'telegram', botUsername: 'deamap_alerts_bot' },
      providerConfig: {},
    });
    const result = await validateAccount(account);

    expect(result.status).toBe('unchecked');
    expect(result.credentialsConfigured).toBe(false);
  });

  // --- brevo ---

  it('should return active when Brevo responds 200', async () => {
    vi.stubEnv('BREVO_MAIN_API_KEY', 'xkeysib-real');
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }));

    const account = makeAccount({
      id: 'email-noreply',
      channel: 'email',
      provider: 'brevo',
      credentialsRef: 'BREVO_MAIN',
      identity: { channel: 'email', address: 'noreply@test.com' },
      providerConfig: {},
    });
    const result = await validateAccount(account);

    expect(result.status).toBe('active');
    expect(fetch).toHaveBeenCalledWith(
      'https://api.brevo.com/v3/account',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  // --- twilio ---

  it('should return active when Twilio responds 200', async () => {
    vi.stubEnv('TWILIO_ALERTS_AUTH_TOKEN', 'real-auth-token');
    vi.stubEnv('TWILIO_ALERTS_ACCOUNT_SID', 'AC1234567890');
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }));

    const account = makeAccount({
      id: 'sms-alerts',
      channel: 'sms',
      provider: 'twilio',
      credentialsRef: 'TWILIO_ALERTS',
      identity: { channel: 'sms', phoneNumber: '+34900000001' },
      providerConfig: {},
    });
    const result = await validateAccount(account);

    expect(result.status).toBe('active');
    expect(fetch).toHaveBeenCalledWith(
      'https://api.twilio.com/2010-04-01/Accounts/AC1234567890.json',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('should return unchecked when Twilio account SID is missing', async () => {
    vi.stubEnv('TWILIO_ALERTS_AUTH_TOKEN', 'real-auth-token');
    // No ACCOUNT_SID

    const account = makeAccount({
      id: 'sms-alerts',
      channel: 'sms',
      provider: 'twilio',
      credentialsRef: 'TWILIO_ALERTS',
      identity: { channel: 'sms', phoneNumber: '+34900000001' },
      providerConfig: {},
    });
    const result = await validateAccount(account);

    expect(result.status).toBe('unchecked');
    expect(result.credentialsConfigured).toBe(false);
  });

  // --- messagebird ---

  it('should return active when MessageBird responds 200', async () => {
    vi.stubEnv('MESSAGEBIRD_PATROL_API_KEY', 'real-api-key');
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }));

    const account = makeAccount({
      id: 'sms-patrol',
      channel: 'sms',
      provider: 'messagebird',
      credentialsRef: 'MESSAGEBIRD_PATROL',
      identity: { channel: 'sms', phoneNumber: '+34900000002' },
      providerConfig: {},
    });
    const result = await validateAccount(account);

    expect(result.status).toBe('active');
    expect(fetch).toHaveBeenCalledWith(
      'https://rest.messagebird.com/balance',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  // --- unknown provider ---

  it('should return unchecked for unknown provider', async () => {
    const account = makeAccount({
      provider: 'evolution-api' as ChannelAccount['provider'],
    });
    const result = await validateAccount(account);

    expect(result.status).toBe('unchecked');
    expect(result.detail).toContain('No validator');
  });
});

describe('validateAllAccounts', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('should skip accounts that are not unchecked', async () => {
    const account = makeAccount({ status: 'suspended' });
    const results = await validateAllAccounts([account]);

    expect(results[0].status).toBe('suspended');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('should validate all unchecked accounts in parallel', async () => {
    vi.stubEnv('WWEBJS_SAMUR_API_KEY', 'key1');
    vi.stubEnv('TG_DEAMAP_ALERTS_TOKEN', 'token1');
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }));

    const accounts = [
      makeAccount(),
      makeAccount({
        id: 'tg-deamap-bot',
        channel: 'telegram',
        provider: 'telegram-bot-api',
        credentialsRef: 'TG_DEAMAP_ALERTS',
        identity: { channel: 'telegram', botUsername: 'deamap_alerts_bot' },
        providerConfig: {},
      }),
    ];

    const results = await validateAllAccounts(accounts);

    expect(results[0].status).toBe('active');
    expect(results[1].status).toBe('active');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
