import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ChannelAccount } from '../../../src/core/accounts/channel-account.js';
import type { InboundPipeline } from '../../../src/core/inbound/inbound-pipeline.js';
import type { ProviderRegistry } from '../../../src/integrations/provider-registry.js';

// A fake WhatsApp socket per connect(). Auth-state loading can be made to fail
// for the first attempt of an account, to simulate a failed startup connect.
const sockets: Array<{ ev: EventEmitter; logout: () => Promise<void> }> = [];
const failFirstAuthLoad = new Set<string>();

vi.mock('@whiskeysockets/baileys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@whiskeysockets/baileys')>()),
  default: () => {
    const socket = { ev: new EventEmitter(), logout: async () => {} };
    sockets.push(socket);
    return socket;
  },
  useMultiFileAuthState: async (authDir: string) => {
    for (const id of failFirstAuthLoad) {
      if (authDir.endsWith(id)) {
        failFirstAuthLoad.delete(id);
        throw new Error('startup connect failed');
      }
    }
    return { state: {}, saveCreds: () => {} };
  },
  fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
}));

const { baileysProvider } = await import('../../../src/integrations/whatsapp/baileys/index.js');
const { EventBus } = await import('../../../src/core/event-bus.js');
const { CredentialValidator } = await import('../../../src/infrastructure/credential-validator.js');
const { connectManagedProviders } = await import('../../../src/infrastructure/connect-managed-providers.js');

const realSetTimeout = setTimeout;
const sleep = (ms: number) => new Promise<void>((r) => realSetTimeout(r, ms));

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !condition(); i++) {
    await sleep(5);
  }
  expect(condition()).toBe(true);
}

function makeAccount(id: string): ChannelAccount {
  return {
    id, alias: id, channel: 'whatsapp', provider: 'baileys', status: 'unchecked', providerConfig: {},
    credentialsRef: '',
    identity: { channel: 'whatsapp', phoneNumber: '+34600000001' },
    metadata: { owner: 'org', environment: 'production', tags: [] },
  } as unknown as ChannelAccount;
}

/** Just enough of the registry for CredentialValidator and connectManagedProviders. */
function makeRegistry(): ProviderRegistry {
  return {
    get: () => baileysProvider,
    getOrThrow: () => baileysProvider,
    getHealthChecker: () => baileysProvider.health!(),
  } as unknown as ProviderRegistry;
}

function waMessage() {
  return {
    key: { remoteJid: '34600111222@s.whatsapp.net', id: 'ABC123', fromMe: false },
    pushName: 'Ana',
    messageTimestamp: 1_700_000_000,
    message: { conversation: 'hola' },
  };
}

describe('Baileys startup ordering', () => {
  const ids: string[] = [];
  afterEach(async () => {
    for (const id of ids.splice(0)) {
      await baileysProvider.connection!().disconnect(id);
      await rm(resolve(process.cwd(), 'data', 'baileys-auth', id), { recursive: true, force: true });
    }
    failFirstAuthLoad.clear();
  });

  it('startup validateAll does not open a socket before the events are wired', async () => {
    const id = 'startup-validate';
    ids.push(id);
    const before = sockets.length;
    const validator = new CredentialValidator(makeRegistry());

    await validator.validateAll([makeAccount(id)]);
    await sleep(50);

    expect(sockets).toHaveLength(before);
    expect(baileysProvider.connection!().hasConnection(id)).toBe(false);
  });

  it('a failed startup connect still leaves the events wired, so a later health-check reconnect delivers inbound', async () => {
    const id = 'startup-connect-fails';
    ids.push(id);
    failFirstAuthLoad.add(id);
    const account = makeAccount(id);
    const inbound = { handle: vi.fn(async () => {}) };
    const registry = makeRegistry();

    await connectManagedProviders([account], registry, new EventBus(), inbound as unknown as InboundPipeline);
    expect(baileysProvider.connection!().hasConnection(id)).toBe(false); // connect threw

    // The periodic health check brings the socket back...
    const result = await baileysProvider.health!().validate(account);
    expect(result.status).not.toBe('active'); // not connected yet
    await waitFor(() => baileysProvider.connection!().hasConnection(id));

    // ...and an inbound message on the new socket reaches the pipeline.
    const socket = sockets.at(-1)!;
    const msg = waMessage();
    socket.ev.emit('messages.upsert', { messages: [msg], type: 'notify' });
    await waitFor(() => inbound.handle.mock.calls.length === 1);

    expect(inbound.handle).toHaveBeenCalledWith(account, expect.objectContaining({ accountId: id }), msg, 'notify');
  });
});
