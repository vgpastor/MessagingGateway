export interface BaileysProviderConfig {
  authDir?: string;
  browser?: [string, string, string];
  connectTimeoutMs?: number;
  retryOnDisconnect?: boolean;
  maxRetries?: number;
  markOnlineOnConnect?: boolean;
}

export function parseBaileysConfig(raw: Record<string, unknown>): BaileysProviderConfig {
  return {
    authDir: raw['authDir'] as string | undefined,
    browser: raw['browser'] as [string, string, string] | undefined,
    connectTimeoutMs: (raw['connectTimeoutMs'] as number | undefined) ?? 60_000,
    retryOnDisconnect: (raw['retryOnDisconnect'] as boolean | undefined) ?? true,
    maxRetries: (raw['maxRetries'] as number | undefined) ?? 5,
    markOnlineOnConnect: (raw['markOnlineOnConnect'] as boolean | undefined) ?? true,
  };
}
