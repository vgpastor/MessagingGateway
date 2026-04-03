import { config } from 'dotenv';
import { resolve } from 'node:path';
import { getLogger } from '../../core/logger/logger.port.js';

config({ path: resolve(process.cwd(), '.env.local') });

const DEV_API_KEY = 'umg-dev-key-not-for-production';

export interface EnvConfig {
  port: number;
  nodeEnv: string;
  logLevel: string;
  apiKey: string;
  webhookCallbackUrl?: string;
  webhookCallbackSecret?: string;
  accountsConfigPath?: string;
  healthCheckIntervalMs: number;
}

export function loadEnvConfig(): EnvConfig {
  const nodeEnv = process.env['NODE_ENV'] ?? 'development';
  const apiKey = resolveApiKey(nodeEnv);

  return {
    port: parseInt(process.env['PORT'] ?? '3000', 10),
    nodeEnv,
    logLevel: process.env['LOG_LEVEL'] ?? 'info',
    apiKey,
    webhookCallbackUrl: process.env['WEBHOOK_CALLBACK_URL'],
    webhookCallbackSecret: process.env['WEBHOOK_CALLBACK_SECRET'],
    accountsConfigPath: process.env['ACCOUNTS_CONFIG_PATH'],
    healthCheckIntervalMs: parseInt(process.env['HEALTH_CHECK_INTERVAL_MS'] ?? '300000', 10),
  };
}

function resolveApiKey(nodeEnv: string): string {
  const configured = process.env['API_KEY'];

  if (configured) {
    if (configured === DEV_API_KEY && nodeEnv !== 'development') {
      throw new Error(
        'SECURITY: The default development API key cannot be used outside NODE_ENV=development. ' +
        'Set a unique API_KEY environment variable for production.',
      );
    }
    return configured;
  }

  // No API_KEY configured
  if (nodeEnv === 'development') {
    getLogger().warn('No API_KEY configured, using default development key', {
      apiKey: DEV_API_KEY,
      note: 'This key ONLY works when NODE_ENV=development. Set a unique API_KEY before deploying.',
    });
    return DEV_API_KEY;
  }

  throw new Error(
    'SECURITY: API_KEY environment variable is required. ' +
    'The gateway cannot start without authentication configured. ' +
    'Set API_KEY to a strong, unique secret.',
  );
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
  'baileys': 'AUTH_DIR',
  'twilio': 'AUTH_TOKEN',
  'messagebird': 'API_KEY',
};

export function resolveProviderCredential(
  credentialsRef: string | undefined,
  provider: string,
  inlineCredential?: string,
): string | undefined {
  // Inline credentials take priority over env vars
  if (inlineCredential) return inlineCredential;
  if (!credentialsRef) return undefined;
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
  credentialsRef: string | undefined,
  provider: string,
  inlineCredential?: string,
): ParsedCredential | undefined {
  const raw = resolveProviderCredential(credentialsRef, provider, inlineCredential);
  if (!raw) return undefined;
  return parseCredentialString(raw);
}
