import { describe, it, expect, vi, afterEach } from 'vitest';
import { configure, customFetch } from '../src/fetch-mutator.js';

afterEach(() => vi.unstubAllGlobals());

function respondWith(body: BodyInit | null, init: ResponseInit) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, init)));
}

type Answer = { data: unknown; status: number; headers: Headers };

describe('customFetch', () => {
  it('sends the configured base URL and key', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    configure({ baseUrl: 'http://gw.test/', apiKey: 'k' });

    await customFetch('/x', {});

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://gw.test/x');
    expect(new Headers(init.headers).get('X-API-Key')).toBe('k');
  });

  it('answers data, status and headers: what the generated types promise', async () => {
    respondWith(JSON.stringify({ a: 1 }), { status: 201, headers: { 'content-type': 'application/json', 'x-y': 'z' } });

    const res = await customFetch<Answer>('/x', {});

    expect(res.data).toEqual({ a: 1 });
    expect(res.status).toBe(201);
    expect(res.headers.get('x-y')).toBe('z');
  });

  it('reads text as text', async () => {
    respondWith('a,b\n1,2', { headers: { 'content-type': 'text/csv; charset=utf-8' } });

    expect((await customFetch<Answer>('/x', {})).data).toBe('a,b\n1,2');
  });

  it('reads anything else as a Blob, without decoding it', async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0x00, 0x80]);
    respondWith(bytes, { headers: { 'content-type': 'image/jpeg' } });

    const { data } = await customFetch<Answer>('/x', {});

    expect(data).toBeInstanceOf(Blob);
    expect(new Uint8Array(await (data as Blob).arrayBuffer())).toEqual(bytes);
  });

  it('has no data on a 204', async () => {
    respondWith(null, { status: 204 });

    const res = await customFetch<Answer>('/x', {});

    expect(res.status).toBe(204);
    expect(res.data).toBeUndefined();
  });

  it('throws on an error status', async () => {
    respondWith(JSON.stringify({ code: 'NOPE', message: 'nope' }), { status: 404, headers: { 'content-type': 'application/json' } });

    await expect(customFetch('/x', {})).rejects.toMatchObject({ message: 'nope', statusCode: 404, code: 'NOPE', response: { code: 'NOPE' } });
  });
});
