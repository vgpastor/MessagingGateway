/**
 * Custom fetch mutator for Orval-generated client.
 * Injects baseUrl and API key authentication.
 *
 * Orval calls: customFetch<T>(url, { method, body, headers, signal, ...options })
 */

let _baseUrl = '';
let _apiKey = '';

export function configure(options: { baseUrl: string; apiKey?: string }) {
  _baseUrl = options.baseUrl.replace(/\/$/, '');
  _apiKey = options.apiKey ?? '';
}

export const customFetch = async <T>(
  url: string,
  options: RequestInit & { params?: Record<string, string> },
): Promise<T> => {
  const fullUrl = `${_baseUrl}${url}`;

  const headers = new Headers(options.headers);
  if (!headers.has('Content-Type') && options.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (_apiKey) {
    headers.set('X-API-Key', _apiKey);
  }

  const response = await fetch(fullUrl, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({
      error: 'Unknown',
      code: 'UNKNOWN',
      message: `HTTP ${response.status}`,
    }));
    throw Object.assign(new Error(error.message ?? `HTTP ${response.status}`), {
      statusCode: response.status,
      code: error.code,
      response: error,
    });
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return response.json() as Promise<T>;
  }
  return response.text() as unknown as T;
};
