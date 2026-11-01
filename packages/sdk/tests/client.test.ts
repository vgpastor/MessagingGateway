import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MessagingGatewayClient } from '../src/client.js';

let server: Server | undefined;

afterEach(async () => {
  vi.unstubAllGlobals();
  server?.closeAllConnections();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
});

/** A server that accepts requests and never answers them. */
async function silentServer(): Promise<string> {
  server = createServer(() => {});
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('MessagingGatewayClient timeout', () => {
  it.each([
    ['get', (c: MessagingGatewayClient) => c.health()],
    ['post', (c: MessagingGatewayClient) => c.accounts.connect('wa')],
    ['getText', (c: MessagingGatewayClient) => c.getText('/x')],
    ['media', (c: MessagingGatewayClient) => c.messages.media('M1')],
  ])('%s gives up on a server that never answers', async (_name, call) => {
    const client = new MessagingGatewayClient({ baseUrl: await silentServer(), timeoutMs: 50 });

    await expect(call(client)).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('waits 30 s by default', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } })));

    await new MessagingGatewayClient({ baseUrl: 'http://gw.test' }).health();

    expect(timeout).toHaveBeenCalledWith(30_000);
    timeout.mockRestore();
  });
});

describe('MessagingGatewayClient errors', () => {
  it('are the same for get and getText', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'BAD', message: 'nope' }), { status: 400 })));
    const client = new MessagingGatewayClient({ baseUrl: 'http://gw.test' });

    await expect(client.get('/x')).rejects.toMatchObject({ name: 'GatewayApiError', statusCode: 400, code: 'BAD', message: 'nope' });
    await expect(client.getText('/x')).rejects.toMatchObject({ name: 'GatewayApiError', statusCode: 400, code: 'BAD', message: 'nope' });
  });

  it('fall back to the HTTP status when the body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 502 })));

    await expect(new MessagingGatewayClient({ baseUrl: 'http://gw.test' }).get('/x'))
      .rejects.toMatchObject({ statusCode: 502, code: 'UNKNOWN', message: 'HTTP 502' });
  });
});

describe('MessagesApi.export', () => {
  it('passes limit and offset, so an export past the cap can be paged', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ messages: [] }), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await new MessagingGatewayClient({ baseUrl: 'http://gw.test' }).messages.export({ limit: 1000, offset: 1000 });

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe('http://gw.test/api/v1/messages/export?limit=1000&offset=1000');
  });
});
