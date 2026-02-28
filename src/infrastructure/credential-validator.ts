import type { ChannelAccount, AccountStatus } from '../domain/accounts/channel-account.js';
import { resolveProviderCredential, resolveCredential } from './config/env.config.js';

export interface ValidationResult {
  status: AccountStatus;
  credentialsConfigured: boolean;
  detail?: string;
}

const VALIDATION_TIMEOUT_MS = 5_000;

export async function validateAccount(account: ChannelAccount): Promise<ValidationResult> {
  const provider = account.provider;

  try {
    switch (provider) {
      case 'wwebjs-api':
        return await validateWwebjs(account);
      case 'telegram-bot-api':
        return await validateTelegram(account);
      case 'brevo':
        return await validateBrevo(account);
      case 'twilio':
        return await validateTwilio(account);
      case 'messagebird':
        return await validateMessageBird(account);
      default:
        return { status: 'unchecked', credentialsConfigured: false, detail: `No validator for provider '${provider}'` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'error', credentialsConfigured: false, detail: message };
  }
}

export async function validateAllAccounts(accounts: ChannelAccount[]): Promise<ChannelAccount[]> {
  const results = await Promise.allSettled(
    accounts.map(async (account) => {
      if (account.status !== 'unchecked') return account;
      const result = await validateAccount(account);
      return { ...account, status: result.status };
    }),
  );

  return results.map((r, i) =>
    r.status === 'fulfilled' ? r.value : { ...accounts[i], status: 'error' as const },
  );
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

// --- Provider-specific validators ---

async function validateWwebjs(account: ChannelAccount): Promise<ValidationResult> {
  const apiKey = resolveProviderCredential(account.credentialsRef, account.provider);
  if (!apiKey) {
    return { status: 'unchecked', credentialsConfigured: false, detail: 'Missing API key' };
  }

  const baseUrl = (account.providerConfig['baseUrl'] as string | undefined) ?? 'http://localhost:3001';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const response = await fetchWithTimeout(`${baseUrl}/api/status`, { method: 'GET', headers });

  if (response.ok) {
    return { status: 'active', credentialsConfigured: true };
  }
  if (response.status === 401 || response.status === 403) {
    return { status: 'auth_expired', credentialsConfigured: true, detail: `HTTP ${response.status}` };
  }
  return { status: 'error', credentialsConfigured: true, detail: `HTTP ${response.status}` };
}

async function validateTelegram(account: ChannelAccount): Promise<ValidationResult> {
  const token = resolveProviderCredential(account.credentialsRef, account.provider);
  if (!token) {
    return { status: 'unchecked', credentialsConfigured: false, detail: 'Missing bot token' };
  }

  const response = await fetchWithTimeout(
    `https://api.telegram.org/bot${token}/getMe`,
    { method: 'GET' },
  );

  if (response.ok) {
    return { status: 'active', credentialsConfigured: true };
  }
  if (response.status === 401) {
    return { status: 'auth_expired', credentialsConfigured: true, detail: 'Invalid bot token' };
  }
  return { status: 'error', credentialsConfigured: true, detail: `HTTP ${response.status}` };
}

async function validateBrevo(account: ChannelAccount): Promise<ValidationResult> {
  const apiKey = resolveProviderCredential(account.credentialsRef, account.provider);
  if (!apiKey) {
    return { status: 'unchecked', credentialsConfigured: false, detail: 'Missing API key' };
  }

  const response = await fetchWithTimeout('https://api.brevo.com/v3/account', {
    method: 'GET',
    headers: { 'api-key': apiKey, 'Accept': 'application/json' },
  });

  if (response.ok) {
    return { status: 'active', credentialsConfigured: true };
  }
  if (response.status === 401) {
    return { status: 'auth_expired', credentialsConfigured: true, detail: 'Invalid API key' };
  }
  return { status: 'error', credentialsConfigured: true, detail: `HTTP ${response.status}` };
}

async function validateTwilio(account: ChannelAccount): Promise<ValidationResult> {
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

async function validateMessageBird(account: ChannelAccount): Promise<ValidationResult> {
  const apiKey = resolveProviderCredential(account.credentialsRef, account.provider);
  if (!apiKey) {
    return { status: 'unchecked', credentialsConfigured: false, detail: 'Missing API key' };
  }

  const response = await fetchWithTimeout('https://rest.messagebird.com/balance', {
    method: 'GET',
    headers: { 'Authorization': `AccessKey ${apiKey}` },
  });

  if (response.ok) {
    return { status: 'active', credentialsConfigured: true };
  }
  if (response.status === 401) {
    return { status: 'auth_expired', credentialsConfigured: true, detail: 'Invalid API key' };
  }
  return { status: 'error', credentialsConfigured: true, detail: `HTTP ${response.status}` };
}
