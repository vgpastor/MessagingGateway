export interface BaileysProviderConfig {
  authDir?: string;
  browser?: [string, string, string];
  waVersion?: [number, number, number];
  connectTimeoutMs?: number;
  qrTimeoutMs?: number;
  retryOnDisconnect?: boolean;
  maxRetries?: number;
  markOnlineOnConnect?: boolean;
}

/** Parse a `[major, minor, patch]` version tuple from untrusted config. */
function parseVersionTuple(raw: unknown): [number, number, number] | undefined {
  if (!Array.isArray(raw) || raw.length !== 3) {
    return undefined;
  }
  const [major, minor, patch] = raw.map((value) => Number(value));
  if (major === undefined || minor === undefined || patch === undefined) {
    return undefined;
  }
  if ([major, minor, patch].some((part) => Number.isNaN(part))) {
    return undefined;
  }
  return [major, minor, patch];
}

export function parseBaileysConfig(raw: Record<string, unknown>): BaileysProviderConfig {
  return {
    authDir: raw['authDir'] as string | undefined,
    browser: raw['browser'] as [string, string, string] | undefined,
    waVersion: parseVersionTuple(raw['waVersion']),
    connectTimeoutMs: (raw['connectTimeoutMs'] as number | undefined) ?? 60_000,
    qrTimeoutMs: (raw['qrTimeoutMs'] as number | undefined) ?? 60_000,
    retryOnDisconnect: (raw['retryOnDisconnect'] as boolean | undefined) ?? true,
    maxRetries: (raw['maxRetries'] as number | undefined) ?? 5,
    markOnlineOnConnect: (raw['markOnlineOnConnect'] as boolean | undefined) ?? true,
  };
}
