import { describe, it, expect, vi, afterEach } from 'vitest';
import { MessagingGatewayClient } from '../src/client.js';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('MessagesApi.after', () => {
  it('calls the afterAccountSeq endpoint with accountId, cursor and limit', async () => {
    const payload = { messages: [], nextAfterAccountSeq: null, lastAccountSeq: 5 };
    const fetchMock = stubFetch(payload);
    const client = new MessagingGatewayClient({ baseUrl: 'http://gw.test/', apiKey: 'k' });

    const result = await client.messages.after('wa-x', 5, 500);

    expect(result).toEqual(payload);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://gw.test/api/v1/messages?accountId=wa-x&afterAccountSeq=5&limit=500');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('k');
  });

  it('defaults the limit to 500 and URL-encodes the account id', async () => {
    const fetchMock = stubFetch({ messages: [], nextAfterAccountSeq: null, lastAccountSeq: 0 });
    const client = new MessagingGatewayClient({ baseUrl: 'http://gw.test' });

    await client.messages.after('wa x', 0);

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe('http://gw.test/api/v1/messages?accountId=wa+x&afterAccountSeq=0&limit=500');
  });

  it('throws GatewayApiError on non-2xx', async () => {
    stubFetch({ code: 'BAD', message: 'nope' }, 400);
    const client = new MessagingGatewayClient({ baseUrl: 'http://gw.test' });
    await expect(client.messages.after('wa-x', 1)).rejects.toMatchObject({ statusCode: 400, code: 'BAD' });
  });
});
