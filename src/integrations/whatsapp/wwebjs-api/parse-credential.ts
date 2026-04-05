/** Parse a wwebjs credential string in format `apiKey` or `apiKey@host:port` */
export function parseCredential(raw: string): { apiKey: string; baseUrl?: string } {
  const atIndex = raw.lastIndexOf('@');
  if (atIndex === -1) return { apiKey: raw };
  const apiKey = raw.substring(0, atIndex);
  const hostPort = raw.substring(atIndex + 1);
  if (!apiKey || !hostPort) return { apiKey: raw };
  const baseUrl = hostPort.startsWith('http') ? hostPort : `http://${hostPort}`;
  return { apiKey, baseUrl };
}
