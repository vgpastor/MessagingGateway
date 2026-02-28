import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(process.cwd(), '.env.local') });

export interface EnvConfig {
  port: number;
  nodeEnv: string;
  logLevel: string;
  webhookCallbackUrl?: string;
  webhookCallbackSecret?: string;
  accountsConfigPath?: string;
}

export function loadEnvConfig(): EnvConfig {
  return {
    port: parseInt(process.env['PORT'] ?? '3000', 10),
    nodeEnv: process.env['NODE_ENV'] ?? 'development',
    logLevel: process.env['LOG_LEVEL'] ?? 'info',
    webhookCallbackUrl: process.env['WEBHOOK_CALLBACK_URL'],
    webhookCallbackSecret: process.env['WEBHOOK_CALLBACK_SECRET'],
    accountsConfigPath: process.env['ACCOUNTS_CONFIG_PATH'],
  };
}

export function resolveCredential(credentialsRef: string, suffix: string): string | undefined {
  const envKey = `${credentialsRef}_${suffix}`;
  return process.env[envKey];
}

const PROVIDER_CREDENTIAL_SUFFIXES: Record<string, string> = {
  'wwebjs-api': 'API_KEY',
  'evolution-api': 'API_KEY',
  'meta-cloud-api': 'ACCESS_TOKEN',
  'telegram-bot-api': 'TOKEN',
  'brevo': 'API_KEY',
  'ses': 'ACCESS_KEY_ID',
  'twilio': 'AUTH_TOKEN',
  'messagebird': 'API_KEY',
};

export function resolveProviderCredential(
  credentialsRef: string,
  provider: string,
): string | undefined {
  const suffix = PROVIDER_CREDENTIAL_SUFFIXES[provider] ?? 'API_KEY';
  return resolveCredential(credentialsRef, suffix);
}

const PLACEHOLDER_PATTERNS = [
  /^api-key-/i,
  /^\d{6}:ABC/,
  /^xkeysib-\.{3}$/,
  /^AKIA\.{3}$/,
  /^AC\.{3}$/,
  /\.\.\.$/,
  /^your-/i,
  /^change-me/i,
  /^xxx/i,
  /^placeholder/i,
];

export function isPlaceholderValue(value: string): boolean {
  return PLACEHOLDER_PATTERNS.some((p) => p.test(value));
}

export function hasValidCredential(credentialsRef: string, provider: string): boolean {
  const value = resolveProviderCredential(credentialsRef, provider);
  if (!value || value.trim() === '') return false;
  return !isPlaceholderValue(value);
}
