/**
 * Replaces the value of any `token` query parameter with `***`, so API keys that travel in
 * the URL (legacy WebSocket auth) never end up in logs.
 */
export function redactUrl(url: string): string {
  return url.replace(/([?&]token=)[^&#]*/gi, '$1***');
}
