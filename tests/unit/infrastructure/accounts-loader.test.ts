import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { loadAccountsFromYaml } from '../../../src/infrastructure/config/accounts.loader.js';

describe('loadAccountsFromYaml', () => {
  const yamlPath = resolve(process.cwd(), 'tests/fixtures/accounts.yaml');

  it('should load accounts from YAML file', () => {
    const accounts = loadAccountsFromYaml(yamlPath);
    expect(accounts.length).toBeGreaterThan(0);
  });

  it('should load WhatsApp accounts correctly', () => {
    const accounts = loadAccountsFromYaml(yamlPath);
    const waAccounts = accounts.filter((a) => a.channel === 'whatsapp');

    expect(waAccounts).toHaveLength(4);

    const acme = waAccounts.find((a) => a.id === 'wa-acme');
    expect(acme).toBeDefined();
    expect(acme!.alias).toBe('Acme WhatsApp');
    expect(acme!.provider).toBe('wwebjs-api');
    expect(acme!.status).toBe('unchecked');
    expect(acme!.identity).toEqual({
      channel: 'whatsapp',
      phoneNumber: '+14155550001',
      wid: undefined,
    });
    expect(acme!.credentialsRef).toBe('WWEBJS_ACME');
    expect(acme!.providerConfig['baseUrl']).toBe('http://wwebjs-acme:3001');
    expect(acme!.metadata.owner).toBe('acme-corp');
    expect(acme!.metadata.tags).toContain('acme');
  });

  it('should load Telegram accounts correctly', () => {
    const accounts = loadAccountsFromYaml(yamlPath);
    const tgAccounts = accounts.filter((a) => a.channel === 'telegram');

    expect(tgAccounts.length).toBeGreaterThanOrEqual(2);

    const alertsBot = tgAccounts.find((a) => a.id === 'tg-alerts-bot');
    expect(alertsBot).toBeDefined();
    expect(alertsBot!.identity).toEqual({
      channel: 'telegram',
      botId: undefined,
      botUsername: 'test_alerts_bot',
    });
  });

  it('should load email accounts correctly', () => {
    const accounts = loadAccountsFromYaml(yamlPath);
    const emailAccounts = accounts.filter((a) => a.channel === 'email');

    expect(emailAccounts.length).toBeGreaterThanOrEqual(2);

    const soporte = emailAccounts.find((a) => a.id === 'email-support');
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
    const acme = accounts.find((a) => a.id === 'wa-acme');
    expect(acme!.metadata.webhookPath).toBe('/webhooks/whatsapp/wa-acme');
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

  it('should default status to unchecked', () => {
    const accounts = loadAccountsFromYaml(yamlPath);
    for (const account of accounts) {
      expect(account.status).toBe('unchecked');
    }
  });

  it('should return empty array when file does not exist', () => {
    const accounts = loadAccountsFromYaml('/nonexistent/path/accounts.yaml');
    expect(accounts).toEqual([]);
  });
});
