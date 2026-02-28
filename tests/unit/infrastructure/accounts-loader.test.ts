import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { loadAccountsFromYaml, validateAccountCredentials } from '../../../src/infrastructure/config/accounts.loader.js';
import { isPlaceholderValue } from '../../../src/infrastructure/config/env.config.js';

describe('loadAccountsFromYaml', () => {
  const yamlPath = resolve(process.cwd(), 'src/infrastructure/config/accounts.yaml');

  it('should load accounts from YAML file', () => {
    const accounts = loadAccountsFromYaml(yamlPath);
    expect(accounts.length).toBeGreaterThan(0);
  });

  it('should load WhatsApp accounts correctly', () => {
    const accounts = loadAccountsFromYaml(yamlPath);
    const waAccounts = accounts.filter((a) => a.channel === 'whatsapp');

    expect(waAccounts).toHaveLength(3);

    const samur = waAccounts.find((a) => a.id === 'wa-samur');
    expect(samur).toBeDefined();
    expect(samur!.alias).toBe('SAMUR WhatsApp');
    expect(samur!.provider).toBe('wwebjs-api');
    expect(samur!.status).toBe('unchecked');
    expect(samur!.identity).toEqual({
      channel: 'whatsapp',
      phoneNumber: '+34600000001',
      wid: undefined,
    });
    expect(samur!.credentialsRef).toBe('WWEBJS_SAMUR');
    expect(samur!.providerConfig['baseUrl']).toBe('http://wwebjs-samur:3001');
    expect(samur!.metadata.owner).toBe('global-emergency');
    expect(samur!.metadata.tags).toContain('emergency');
  });

  it('should load Telegram accounts correctly', () => {
    const accounts = loadAccountsFromYaml(yamlPath);
    const tgAccounts = accounts.filter((a) => a.channel === 'telegram');

    expect(tgAccounts.length).toBeGreaterThanOrEqual(2);

    const deamap = tgAccounts.find((a) => a.id === 'tg-deamap-bot');
    expect(deamap).toBeDefined();
    expect(deamap!.identity).toEqual({
      channel: 'telegram',
      botId: undefined,
      botUsername: 'test_alerts_bot',
    });
  });

  it('should load email accounts correctly', () => {
    const accounts = loadAccountsFromYaml(yamlPath);
    const emailAccounts = accounts.filter((a) => a.channel === 'email');

    expect(emailAccounts.length).toBeGreaterThanOrEqual(2);

    const soporte = emailAccounts.find((a) => a.id === 'email-patroltech-soporte');
    expect(soporte).toBeDefined();
    expect(soporte!.identity).toEqual({
      channel: 'email',
      address: 'support@example.com',
      domain: undefined,
    });
    expect(soporte!.credentialsRef).toBe('BREVO_MAIN');
  });

  it('should load SMS accounts correctly', () => {
    const accounts = loadAccountsFromYaml(yamlPath);
    const smsAccounts = accounts.filter((a) => a.channel === 'sms');

    expect(smsAccounts).toHaveLength(2);

    const twilioAccount = smsAccounts.find((a) => a.provider === 'twilio');
    expect(twilioAccount).toBeDefined();

    const mbAccount = smsAccounts.find((a) => a.provider === 'messagebird');
    expect(mbAccount).toBeDefined();
  });

  it('should set default webhook paths', () => {
    const accounts = loadAccountsFromYaml(yamlPath);
    const samur = accounts.find((a) => a.id === 'wa-samur');
    expect(samur!.metadata.webhookPath).toBe('/webhooks/whatsapp/wa-samur');
  });

  it('should not include credential values in accounts', () => {
    const accounts = loadAccountsFromYaml(yamlPath);
    for (const account of accounts) {
      expect(account.credentialsRef).toBeDefined();
      expect(typeof account.credentialsRef).toBe('string');
      // credentialsRef is just a reference, not the actual secret
      expect(account.credentialsRef).not.toContain('=');
    }
  });
});

describe('isPlaceholderValue', () => {
  it('should detect common placeholder patterns', () => {
    expect(isPlaceholderValue('api-key-samur')).toBe(true);
    expect(isPlaceholderValue('123456:ABC-xyz...')).toBe(true);
    expect(isPlaceholderValue('xkeysib-...')).toBe(true);
    expect(isPlaceholderValue('AKIA...')).toBe(true);
    expect(isPlaceholderValue('AC...')).toBe(true);
    expect(isPlaceholderValue('your-secret-for-signing')).toBe(true);
    expect(isPlaceholderValue('change-me')).toBe(true);
    expect(isPlaceholderValue('xxx-placeholder')).toBe(true);
    expect(isPlaceholderValue('placeholder-value')).toBe(true);
  });

  it('should not flag real-looking values', () => {
    expect(isPlaceholderValue('sk_live_a1b2c3d4e5f6')).toBe(false);
    expect(isPlaceholderValue('7890123456:AAF-real-telegram-token')).toBe(false);
    expect(isPlaceholderValue('AKIAexamplekeyid1234')).toBe(false);
  });
});

describe('validateAccountCredentials', () => {
  const credYamlPath = resolve(process.cwd(), 'src/infrastructure/config/accounts.yaml');

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should keep status as unchecked when credential env var is missing', () => {
    const accounts = loadAccountsFromYaml(credYamlPath);
    const validated = validateAccountCredentials(accounts);

    for (const account of validated) {
      expect(account.status).toBe('unchecked');
    }
  });

  it('should set status to active when valid credential is present', () => {
    vi.stubEnv('WWEBJS_SAMUR_API_KEY', 'sk_live_real_credential_value');

    const accounts = loadAccountsFromYaml(credYamlPath);
    const validated = validateAccountCredentials(accounts);

    const samur = validated.find((a) => a.id === 'wa-samur');
    expect(samur!.status).toBe('active');

    const patroltech = validated.find((a) => a.id === 'wa-patroltech');
    expect(patroltech!.status).toBe('unchecked');
  });

  it('should keep status as unchecked when credential is a placeholder', () => {
    vi.stubEnv('WWEBJS_SAMUR_API_KEY', 'api-key-samur');

    const accounts = loadAccountsFromYaml(credYamlPath);
    const validated = validateAccountCredentials(accounts);

    const samur = validated.find((a) => a.id === 'wa-samur');
    expect(samur!.status).toBe('unchecked');
  });
});
