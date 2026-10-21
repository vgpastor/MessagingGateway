import { describe, it, expect, vi } from 'vitest';
import { openSocket, type SocketHandlers } from '../src/socket.js';

const handlers: SocketHandlers = {
  onOpen: vi.fn(), onMessage: vi.fn(), onPing: vi.fn(), onClose: vi.fn(), onError: vi.fn(),
};

describe('openSocket in a browser-like runtime', () => {
  it('passes the api key as the umg.<key> subprotocol and keeps it out of the URL', () => {
    const created: Array<{ url: string; protocols?: string | string[] }> = [];
    class FakeBrowserWebSocket {
      static OPEN = 1;
      readyState = 0;
      constructor(url: string, protocols?: string | string[]) { created.push({ url, protocols }); }
      addEventListener() {}
      send() {}
      close() {}
    }
    const sock = openSocket('ws://gw.test/ws/events?accounts=wa-1', 'deadbeef', handlers, {
      isNode: false,
      BrowserWebSocket: FakeBrowserWebSocket as unknown as typeof WebSocket,
    });

    expect(created).toEqual([{ url: 'ws://gw.test/ws/events?accounts=wa-1', protocols: ['umg.deadbeef'] }]);
    expect(sock.supportsPing).toBe(false);
  });

  it('offers no subprotocol when there is no api key', () => {
    const created: Array<{ protocols?: string | string[] }> = [];
    class Fake {
      readyState = 0;
      constructor(_u: string, protocols?: string | string[]) { created.push({ protocols }); }
      addEventListener() {}
      send() {}
      close() {}
    }
    openSocket('ws://gw.test/ws/events', '', handlers, { isNode: false, BrowserWebSocket: Fake as unknown as typeof WebSocket });
    expect(created[0].protocols).toBeUndefined();
  });
});
