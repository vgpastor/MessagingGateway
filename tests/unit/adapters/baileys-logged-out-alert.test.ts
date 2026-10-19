import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ChannelAccount } from '../../../src/core/accounts/channel-account.js';
import type { WebhookForwarder } from '../../../src/connections/webhooks/webhook-forwarder.js';

// A fake WhatsApp socket per connect(): the test drives its 'connection.update'.
const sockets: Array<{ ev: EventEmitter; logout: () => Promise<void> }> = [];

vi.mock('@whiskeysockets/baileys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@whiskeysockets/baileys')>()),
  default: () => {
    const ev = new EventEmitter();
    const socket = {
      ev,
      // Baileys' real logout() closes the socket with 401 loggedOut.
      logout: async () => { ev.emit('connection.update', close(401)); },
    };
    sockets.push(socket);
    return socket;
  },
  useMultiFileAuthState: async () => ({ state: {}, saveCreds: () => {} }),
  fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
}));

const { baileysProvider } = await import('../../../src/integrations/whatsapp/baileys/index.js');
const { EventBus } = await import('../../../src/core/event-bus.js');
const { subscribeConnectionAlerts } = await import('../../../src/connections/webhooks/connection-alert.subscriber.js');

const ALERT_URL = 'https://alerts.test/hook';

function close(statusCode: number) {
  return { connection: 'close', lastDisconnect: { error: { output: { statusCode } }, date: new Date() } };
}

const flush = () => new Promise((r) => setImmediate(r));

async function setup(accountId: string) {
  const eventBus = new EventBus();
  const forwarder = { forwardRaw: vi.fn(async () => {}), send: vi.fn(async () => {}) };
  subscribeConnectionAlerts(eventBus, forwarder as unknown as WebhookForwarder, ALERT_URL);

  const account = { id: accountId, channel: 'whatsapp', provider: 'baileys', providerConfig: {} } as unknown as ChannelAccount;
  await baileysProvider.connection!().connect(accountId, {});
  await baileysProvider.wireEvents!(account, eventBus);
  return { forwarder, socket: sockets.at(-1)! };
}

describe('Baileys 401 loggedOut alert', () => {
  const accounts: string[] = [];
  afterEach(async () => {
    for (const id of accounts.splice(0)) {
      await rm(resolve(process.cwd(), 'data', 'baileys-auth', id), { recursive: true, force: true });
    }
  });

  it('sends exactly one auth_expired alert per transition', async () => {
    accounts.push('alert-401');
    const { forwarder, socket } = await setup('alert-401');

    socket.ev.emit('connection.update', close(401));
    socket.ev.emit('connection.update', close(401)); // a repeated close must not re-alert
    await flush();

    expect(forwarder.forwardRaw).toHaveBeenCalledTimes(1);
    expect(forwarder.forwardRaw).toHaveBeenCalledWith(
      'alert-401',
      expect.objectContaining({ accountId: 'alert-401', status: 'auth_expired' }),
      'connection.update',
    );
    expect(forwarder.send).toHaveBeenCalledTimes(1);
    expect(forwarder.send).toHaveBeenCalledWith(
      ALERT_URL, undefined, 'alert-401', expect.objectContaining({ status: 'auth_expired' }), 'connection.update',
    );

    // Re-paired (reset → new socket) and lost again: a new transition, a new alert.
    await baileysProvider.connection!().connect('alert-401', {});
    const repaired = sockets.at(-1)!;
    repaired.ev.emit('connection.update', { connection: 'open' });
    repaired.ev.emit('connection.update', close(401));
    await flush();
    expect(forwarder.forwardRaw).toHaveBeenCalledTimes(2);
  });

  it('does not alert on a transient close or an intentional disconnect', async () => {
    accounts.push('alert-quiet');
    const { forwarder, socket } = await setup('alert-quiet');

    const before = sockets.length;
    socket.ev.emit('connection.update', close(428)); // connectionClosed → reconnects
    await vi.waitFor(() => expect(baileysProvider.connection!().hasConnection('alert-quiet')).toBe(true));
    expect(sockets.length).toBe(before + 1);

    await baileysProvider.connection!().disconnect('alert-quiet'); // logout() emits a 401 close
    await flush();

    expect(forwarder.forwardRaw).not.toHaveBeenCalled();
    expect(forwarder.send).not.toHaveBeenCalled();
  });
});
