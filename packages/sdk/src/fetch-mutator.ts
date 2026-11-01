/**
 * Custom fetch mutator for Orval-generated client.
 * Injects baseUrl, API key authentication and a time limit.
 *
 * Orval calls: customFetch<T>(url, { method, body, headers, signal, ...options })
 * and types the answer as `{ data, status, headers }`, with the body as `data`.
 *
 * An error status throws instead of being returned, so the error members of the generated
 * unions never arrive: those unions only list the errors a route documents, and a 401 or a
 * 500 must not pass for data. The error carries `statusCode`, `code` and the body in `response`.
 */

const DEFAULT_TIMEOUT_MS = 30_000;

let _baseUrl = '';
let _apiKey = '';
let _timeoutMs = DEFAULT_TIMEOUT_MS;

/** One configuration for the whole process: the last call wins. See the README for several keys. */
export function configure(options: { baseUrl: string; apiKey?: string; timeoutMs?: number }) {
  _baseUrl = options.baseUrl.replace(/\/$/, '');
  _apiKey = options.apiKey ?? '';
  _timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
  if (_apiKey && !headers.has('X-API-Key')) {
    headers.set('X-API-Key', _apiKey);
  }

  // The limit covers the whole exchange, reading the body included, as in the REST client.
  const timeout = AbortSignal.timeout(_timeoutMs);

  const response = await fetch(fullUrl, {
    ...options,
    headers,
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
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

  return { data: await readBody(response), status: response.status, headers: response.headers } as T;
};

/** A binary body stays a Blob, as the generated types say: decoding it as text would corrupt it. */
async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) return response.json();
  if (contentType.startsWith('text/')) return response.text();
  return response.blob();
}
