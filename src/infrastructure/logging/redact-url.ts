/**
 * Redacts API keys that travel in the URL (legacy WebSocket auth) before it is logged.
 *
 * Every query parameter whose DECODED name is `token` (case-insensitive) gets its value replaced
 * with `***`, so encoded spellings such as `?%74oken=KEY` are covered too. If the query string
 * cannot be decoded, the whole query string is dropped rather than risk leaking a key.
 */
export function redactUrl(url: string): string {
  const queryStart = url.indexOf('?');
  if (queryStart === -1) return url;

  const path = url.slice(0, queryStart);
  const query = url.slice(queryStart + 1);

  try {
    const redacted = query
      .split('&')
      .map((pair) => {
        const eq = pair.indexOf('=');
        const rawName = eq === -1 ? pair : pair.slice(0, eq);
        return isTokenParam(rawName) ? `${rawName}=***` : pair;
      })
      .join('&');
    return `${path}?${redacted}`;
  } catch {
    return path;
  }
}

/** True when the percent-decoded name is `token`; throws on malformed escapes. */
function isTokenParam(rawName: string): boolean {
  // `+` is a space in form encoding but a literal in other parsers: check both readings.
  const asIs = decodeURIComponent(rawName).toLowerCase();
  const plusAsSpace = decodeURIComponent(rawName.replace(/\+/g, ' ')).toLowerCase();
  return asIs === 'token' || plusAsSpace === 'token';
}
