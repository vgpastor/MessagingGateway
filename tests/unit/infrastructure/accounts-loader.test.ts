import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { loadAccountsFromYaml } from '../../../src/infrastructure/config/accounts.loader.js';

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
      botUsername: 'deamap_alerts_bot',
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
      address: 'soporte@patroltech.com',
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
