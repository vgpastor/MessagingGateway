import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ChannelAccount } from '../../../src/core/accounts/channel-account.js';
import type { WebhookForwarder } from '../../../src/connections/webhooks/webhook-forwarder.js';
import type { InboundPipeline } from '../../../src/core/inbound/inbound-pipeline.js';

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

const { createBaileysProvider } = await import('../../../src/integrations/whatsapp/baileys/index.js');
const baileysProvider = createBaileysProvider();
const { EventBus } = await import('../../../src/core/event-bus.js');
const { subscribeConnectionAlerts } = await import('../../../src/connections/webhooks/connection-alert.subscriber.js');

const ALERT_URL = 'https://alerts.test/hook';

function close(statusCode: number) {
  return { connection: 'close', lastDisconnect: { error: { output: { statusCode } }, date: new Date() } };
}

const flush = () => new Promise((r) => setImmediate(r));

async function setup(accountId: string) {
  const eventBus = new EventBus();
  const forwarder = { forwardRaw: vi.fn(async () => {}), sendConfirmed: vi.fn(async () => true) };
  subscribeConnectionAlerts({
    eventBus,
    webhookForwarder: forwarder as unknown as WebhookForwarder,
    accounts: { findById: async (id) => ({ id, status: 'active' }) as ChannelAccount },
    alertWebhookUrl: ALERT_URL,
  });

  const account = { id: accountId, channel: 'whatsapp', provider: 'baileys', providerConfig: {} } as unknown as ChannelAccount;
  await baileysProvider.connection!().connect(accountId, {});
  await baileysProvider.wireEvents!(account, eventBus, { handle: vi.fn(async () => {}) } as unknown as InboundPipeline);
  return { forwarder, socket: sockets.at(-1)! };
}

describe('Baileys connection events', () => {
  const accounts: string[] = [];
  afterEach(async () => {
    for (const id of accounts.splice(0)) {
      await rm(resolve(process.cwd(), 'data', 'baileys-auth', id), { recursive: true, force: true });
    }
  });

  async function wired(accountId: string) {
    accounts.push(accountId);
    const eventBus = new EventBus();
    const events: Array<Record<string, unknown>> = [];
    eventBus.on<Record<string, unknown>>('connection.update', (event) => { events.push(event.data); });
    const account = { id: accountId, channel: 'whatsapp', provider: 'baileys', providerConfig: {} } as unknown as ChannelAccount;
    await baileysProvider.connection!().connect(accountId, {});
    await baileysProvider.wireEvents!(account, eventBus, { handle: vi.fn(async () => {}) } as unknown as InboundPipeline);
    return { events, socket: sockets.at(-1)! };
  }

  it.each([401, 403])('reports a %i close as auth_expired with its code', async (code) => {
    const { events, socket } = await wired(`event-${code}`);

    socket.ev.emit('connection.update', close(code));
    await flush();

    expect(events).toEqual([expect.objectContaining({ status: 'auth_expired', closeCode: code })]);
  });

  it('reports a transient close as disconnected, not as a lost session', async () => {
    const { events, socket } = await wired('event-428');

    socket.ev.emit('connection.update', close(428));
    await flush();

    expect(events).toEqual([expect.objectContaining({ status: 'disconnected', closeCode: 428 })]);
    await baileysProvider.connection!().disconnect('event-428');
  });

  it('reports an intentional disconnect as deliberate, once', async () => {
    const { events } = await wired('event-deliberate');

    await baileysProvider.connection!().disconnect('event-deliberate'); // logout() emits a 401 close
    await flush();

    expect(events).toEqual([expect.objectContaining({ status: 'disconnected', deliberate: true })]);
  });
});

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
    expect(forwarder.sendConfirmed).toHaveBeenCalledTimes(1);
    expect(forwarder.sendConfirmed).toHaveBeenCalledWith(
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

    socket.ev.emit('connection.update', close(428)); // connectionClosed → backs off, then reconnects
    await flush();
    // The account stays registered while it waits for its (jittered) retry; the
    // reconnect itself is covered in baileys-socket-manager.test.ts.
    expect(baileysProvider.connection!().hasConnection('alert-quiet')).toBe(true);

    await baileysProvider.connection!().disconnect('alert-quiet'); // logout() emits a 401 close
    await flush();

    expect(forwarder.forwardRaw).not.toHaveBeenCalled();
    expect(forwarder.sendConfirmed).not.toHaveBeenCalled();
  });
});
