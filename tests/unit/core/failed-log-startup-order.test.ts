/**
 * The failed log through a real start, in the order `src/index.ts` runs it: replay, connect, replay again.
 * The Baileys provider is the real one over a fake WhatsApp socket, so a LID cannot be resolved until the
 * account has a socket, exactly as in production. The log, the file and the pipeline are real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ChannelAccount } from '../../../src/core/accounts/channel-account.js';
import type { UnifiedEnvelope } from '../../../src/core/messaging/unified-envelope.js';

const KNOWN_LID = '100000000000001@lid';
const UNKNOWN_LID = '100000000000002@lid';
const PHONE_JID = '34600111222@s.whatsapp.net';

const sockets = vi.hoisted(() => [] as Array<{ ev: import('node:events').EventEmitter }>);

vi.mock('@whiskeysockets/baileys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@whiskeysockets/baileys')>()),
  default: () => {
    const socket = {
      ev: new EventEmitter(),
      logout: async () => {},
      signalRepository: {
        lidMapping: { getPNForLID: async (lid: string) => (lid === KNOWN_LID ? `34600111222:5@s.whatsapp.net` : null) },
      },
    };
    sockets.push(socket);
    return socket;
  },
  useMultiFileAuthState: async () => ({ state: {}, saveCreds: () => {} }),
  fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
}));

const { createBaileysProvider } = await import('../../../src/integrations/whatsapp/baileys/index.js');
const { ProviderRegistry } = await import('../../../src/integrations/provider-registry.js');
const { connectManagedProviders } = await import('../../../src/infrastructure/connect-managed-providers.js');
const { EventBus } = await import('../../../src/core/event-bus.js');
const { InboundPipeline } = await import('../../../src/core/inbound/inbound-pipeline.js');
const { noopMetrics } = await import('../../../src/core/metrics/metrics.port.js');
const { FailedInboundFile } = await import('../../../src/persistence/failed-inbound-file.js');
const { SqliteMessageStore } = await import('../../../src/persistence/sqlite-message-store.js');

const ACCOUNT_ID = 'startup-order';

const account = {
  id: ACCOUNT_ID, alias: 'a', channel: 'whatsapp', provider: 'baileys', status: 'active', providerConfig: {},
  conversations: [PHONE_JID],
  identity: { channel: 'whatsapp', phoneNumber: '+34600000001' },
  metadata: { owner: 'org', environment: 'production', tags: [] },
} as unknown as ChannelAccount;

function envelope(id: string, conversationId: string, accountId = ACCOUNT_ID): UnifiedEnvelope {
  const when = new Date('2026-05-01T10:00:00.000Z');
  return {
    id,
    accountId,
    channel: 'whatsapp',
    direction: 'inbound',
    timestamp: when,
    conversationId,
    sender: { id: conversationId },
    recipient: { id: '+34600000001' },
    content: { type: 'text', body: 'hola' },
    channelDetails: { platform: 'whatsapp', messageId: `wa-${id}` },
    gateway: { receivedAt: when, adapterId: 'baileys', account: { id: accountId, alias: 'a', owner: 'o', tags: [] } },
  };
}

describe('the failed log through a real start', () => {
  let dir: string;
  let path: string;
  let file: InstanceType<typeof FailedInboundFile>;
  let store: InstanceType<typeof SqliteMessageStore>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mg-startup-'));
    path = join(dir, 'failed-inbound.jsonl');
    file = new FailedInboundFile(path);
    store = new SqliteMessageStore(':memory:');
    await store.init();
    await store.runMigrations();
  });

  afterEach(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
    await rm(resolve(process.cwd(), 'data', 'baileys-auth', ACCOUNT_ID), { recursive: true, force: true });
  });

  function start(heldRetryIntervalMs?: number) {
    const provider = createBaileysProvider();
    const registry = new ProviderRegistry();
    registry.register(provider);
    const eventBus = new EventBus();
    const media = { process: vi.fn(async () => {}), resumePendingMedia: vi.fn(async () => 0) };
    const pipeline = new InboundPipeline({
      store,
      failedLog: file,
      eventBus,
      media,
      metrics: noopMetrics,
      accounts: { findById: async (id: string) => (id === ACCOUNT_ID ? account : undefined) },
      resolveLidToPhone: provider.resolveLidToPhone,
      isConnected: (a: ChannelAccount) => registry.getConnectionManager(a.provider)?.getConnectionInfo(a.id).status === 'connected',
      persistRetryDelaysMs: [],
      heldRetryIntervalMs,
    });
    return { pipeline, media, connect: () => connectManagedProviders([account], registry, eventBus, pipeline) };
  }

  const fileIds = async (): Promise<string[]> => (existsSync(path)
    ? (await readFile(path, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line).envelope.id as string)
    : []);

  it('before connecting a LID cannot be judged: it stays, and what its account has behind it too; after connecting they go in, in their order', async () => {
    await file.append({ envelope: envelope('lid', KNOWN_LID), raw: undefined });
    await file.append({ envelope: envelope('excluded', 'other@s.whatsapp.net'), raw: undefined });
    await file.append({ envelope: envelope('orphan', PHONE_JID, 'gone'), raw: undefined });
    await file.append({ envelope: envelope('allowed', PHONE_JID), raw: undefined });
    const { pipeline, connect, media } = start(1);

    await pipeline.replayFailed();

    expect(await fileIds()).toEqual(['lid', 'excluded', 'allowed']);
    expect(await store.count({ accountId: ACCOUNT_ID })).toBe(0);

    await connect();
    await vi.waitFor(() => expect(existsSync(path)).toBe(false));

    const page = await store.queryAfter({ accountId: ACCOUNT_ID, afterAccountSeq: 0, limit: 10 });
    expect(page.messages.map((m) => [m.id, m.accountSeq, m.conversationId])).toEqual([
      ['lid', 1, PHONE_JID],
      ['allowed', 2, PHONE_JID],
    ]);
    await vi.waitFor(() => expect(media.resumePendingMedia).toHaveBeenCalledTimes(1));
    await pipeline.drain(10);
  });

  it('a LID still unresolved after connecting stays in the file for the next start', async () => {
    await file.append({ envelope: envelope('unknown', UNKNOWN_LID), raw: undefined });
    const { pipeline, connect, media } = start();

    await pipeline.replayFailed();
    await connect();
    await pipeline.replayFailed();

    expect(await fileIds()).toEqual(['unknown']);
    expect(await store.count({ accountId: ACCOUNT_ID })).toBe(0);
    expect(media.resumePendingMedia).not.toHaveBeenCalled();
    await pipeline.drain(10);
  });

  it('a LID unresolved for more than 7 days leaves the file only once its account has really connected', async () => {
    const old = envelope('old', UNKNOWN_LID);
    old.gateway.receivedAt = new Date(Date.now() - 8 * 86_400_000);
    await file.append({ envelope: old, raw: undefined });
    const { pipeline, connect } = start();

    await pipeline.replayFailed();
    expect(await fileIds()).toEqual(['old']);

    await connect(); // a socket, still connecting: the pass that follows must not take that for a chance it had
    await pipeline.replayFailed();
    expect(await fileIds()).toEqual(['old']);

    sockets.at(-1)!.ev.emit('connection.update', { connection: 'open' });
    await pipeline.replayFailed();

    expect(existsSync(path)).toBe(false);
    const [rejected] = (await readFile(join(dir, 'failed-inbound.rejected.jsonl'), 'utf8')).trim().split('\n');
    expect(JSON.parse(JSON.parse(rejected!).line).envelope.id).toBe('old');
    await pipeline.drain(10);
  });

  it('an account that connects late, waiting for a QR, gets its LID and its queue in without a restart, behind what arrived live meanwhile', async () => {
    await file.append({ envelope: envelope('lid', KNOWN_LID), raw: undefined });
    await file.append({ envelope: envelope('behind', PHONE_JID), raw: undefined });
    const { pipeline, connect, media } = start(1);
    await pipeline.replayFailed();

    // Pass after pass, with no socket to resolve the LID.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await fileIds()).toEqual(['lid', 'behind']);
    await pipeline.handle(account, envelope('live', PHONE_JID), {});

    await connect();
    await vi.waitFor(() => expect(existsSync(path)).toBe(false));
    await vi.waitFor(() => expect(media.resumePendingMedia).toHaveBeenCalled());

    const page = await store.queryAfter({ accountId: ACCOUNT_ID, afterAccountSeq: 0, limit: 10 });
    expect(page.messages.map((m) => [m.id, m.accountSeq])).toEqual([['live', 1], ['lid', 2], ['behind', 3]]);
    await pipeline.drain(10);
  });
});
