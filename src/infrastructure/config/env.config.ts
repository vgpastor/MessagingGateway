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

export interface ParsedCredential {
  apiKey: string;
  baseUrl?: string;
}

/**
 * Parses a credential string that may contain connection info.
 * Supported formats:
 *   - "apiKey"                        → { apiKey }
 *   - "user:apiKey@host:port"         → { apiKey: "user:apiKey", baseUrl: "http://host:port" }
 *   - "apiKey@host:port"              → { apiKey, baseUrl: "http://host:port" }
 */
export function parseCredentialString(raw: string): ParsedCredential {
  const atIndex = raw.lastIndexOf('@');
  if (atIndex === -1) {
    return { apiKey: raw };
  }

  const apiKey = raw.substring(0, atIndex);
  const hostPort = raw.substring(atIndex + 1);

  if (!apiKey || !hostPort) {
    return { apiKey: raw };
  }

  const baseUrl = hostPort.startsWith('http') ? hostPort : `http://${hostPort}`;
  return { apiKey, baseUrl };
}

export function resolveProviderCredentialParsed(
  credentialsRef: string,
  provider: string,
): ParsedCredential | undefined {
  const raw = resolveProviderCredential(credentialsRef, provider);
  if (!raw) return undefined;
  return parseCredentialString(raw);
}
