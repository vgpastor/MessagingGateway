/**
 * Custom fetch mutator for Orval-generated client.
 * Injects baseUrl and API key authentication.
 *
 * Orval calls: customFetch<T>(url, { method, body, headers, signal, ...options })
 * and types the answer as `{ data, status, headers }`, with the body as `data`.
 *
 * An error status throws instead of being returned, so the error members of the generated
 * unions never arrive: those unions only list the errors a route documents, and a 401 or a
 * 500 must not pass for data. The error carries `statusCode`, `code` and the body in `response`.
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
