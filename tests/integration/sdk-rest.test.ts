/**
 * The SDK's REST clients against the real gateway over HTTP: real store, real files on disk,
 * real serialization. What a consumer gets, byte for byte.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteMessageStore } from '../../src/persistence/sqlite-message-store.js';
import { DiskMediaStore } from '../../src/persistence/media/disk-media-store.js';
import type { UnifiedEnvelope } from '../../src/core/messaging/unified-envelope.js';
import type { MediaInfo } from '../../src/core/messaging/content.js';
import { MessagingGatewayClient } from '../../packages/sdk/src/client.js';
import { configure } from '../../packages/sdk/src/fetch-mutator.js';
import { getApiV1MediaId, getApiV1Messages } from '../../packages/sdk/src/generated/api.js';
import { buildTestServer, ADMIN_KEY, READ_KEY } from './helpers/test-server.js';

function imageEnvelope(id: string, media: MediaInfo): UnifiedEnvelope {
  return {
    id,
    accountId: 'wa-test',
    channel: 'whatsapp',
    direction: 'inbound',
    timestamp: new Date('2026-10-20T10:00:00Z'),
    conversationId: '34600000001@s.whatsapp.net',
    sender: { id: '34600000001@s.whatsapp.net' },
    recipient: { id: '+34600000099' },
    content: { type: 'image', media },
    channelDetails: { platform: 'whatsapp', messageId: id },
    gateway: {
      receivedAt: new Date('2026-10-20T10:00:00Z'),
      adapterId: 'baileys',
      account: { id: 'wa-test', alias: 'Test', owner: 'o', tags: [] },
    },
  } as UnifiedEnvelope;
}

// Not valid UTF-8: anything that decodes it as text on the way corrupts it.
const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x80, 0xfe, 0x0a, 0x0d, 0x00]);

let app: FastifyInstance;
let store: SqliteMessageStore;
let dir: string;
let baseUrl: string;
let client: MessagingGatewayClient;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sdk-rest-'));
  const mediaStore = new DiskMediaStore(dir);
  store = new SqliteMessageStore(':memory:');
  await store.init();
  await store.runMigrations();

  const pending = { mimeType: 'image/jpeg', status: 'pending' } as const;
  await store.insertInbound(imageEnvelope('READY1', pending), {});
  await mediaStore.write('wa-test', 'READY1', 'jpg', bytes);
  await store.updateMedia('READY1', { status: 'ready', size: bytes.length, url: '/api/v1/media/READY1' });
  await store.insertInbound(imageEnvelope('PEND1', pending), {});
  await store.insertInbound(imageEnvelope('wa/1:PEND2', pending), {});
  await store.insertInbound(imageEnvelope('SKIP1', pending), {});
  await store.updateMedia('SKIP1', { status: 'skipped', skipReason: 'too_large' });
  await store.insertInbound(imageEnvelope('EXP1', pending), {});
  await store.updateMedia('EXP1', { status: 'expired' });

  app = await buildTestServer({ messageStore: store, mediaStore });
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  client = new MessagingGatewayClient({ baseUrl, apiKey: READ_KEY });
});

afterAll(async () => {
  await app.close();
  await store.close();
  await rm(dir, { recursive: true, force: true });
});

describe('client.messages.media', () => {
  it('downloads the file intact, with its type', async () => {
    const media = await client.messages.media('READY1');

    expect(media.status).toBe('ready');
    if (media.status !== 'ready') return;
    expect(Buffer.from(media.data).equals(bytes)).toBe(true);
    expect(media.mimeType).toBe('image/jpeg');
  });

  it('says so while the file is still downloading, instead of handing over the JSON as if it were the file', async () => {
    await expect(client.messages.media('PEND1')).resolves.toEqual({ status: 'pending' });
  });

  it('says why when the file will never be there', async () => {
    await expect(client.messages.media('SKIP1')).resolves.toEqual({ status: 'skipped', skipReason: 'too_large' });
    await expect(client.messages.media('EXP1')).resolves.toEqual({ status: 'expired' });
  });

  it('encodes the message id', async () => {
    await expect(client.messages.media('wa/1:PEND2')).resolves.toEqual({ status: 'pending' });
  });

  it('throws on a message without media', async () => {
    await expect(client.messages.media('NOPE')).rejects.toMatchObject({ statusCode: 404, code: 'MEDIA_NOT_FOUND' });
  });

  it('throws on a wrong key', async () => {
    const stranger = new MessagingGatewayClient({ baseUrl, apiKey: 'wrong' });
    await expect(stranger.messages.media('READY1')).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe('client.messages.after', () => {
  it('reports the first and last accountSeq with the page', async () => {
    const page = await client.messages.after('wa-test', 0, 2);

    expect(page.messages.map((m) => m.accountSeq)).toEqual([1, 2]);
    expect(page.nextAfterAccountSeq).toBe(2);
    expect(page.firstAccountSeq).toBe(1);
    expect(page.lastAccountSeq).toBe(5);
  });
});

describe('generated client', () => {
  beforeAll(() => configure({ baseUrl, apiKey: ADMIN_KEY }));

  it('answers { data, status, headers } as its types say', async () => {
    const res = await getApiV1Messages({ accountId: 'wa-test', limit: '1' });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.data.messages).toHaveLength(1);
  });

  it('gets a binary body as an intact Blob', async () => {
    const res = await getApiV1MediaId('READY1');

    expect(res.status).toBe(200);
    expect(res.data).toBeInstanceOf(Blob);
    expect(Buffer.from(await (res.data as Blob).arrayBuffer()).equals(bytes)).toBe(true);
  });

  it('gets a 202 as data too', async () => {
    const res = await getApiV1MediaId('PEND1');

    expect(res.status).toBe(202);
    expect(res.data).toEqual({ status: 'pending' });
  });

  it('throws on an error status, with what the server said', async () => {
    await expect(getApiV1MediaId('NOPE')).rejects.toMatchObject({ statusCode: 404, code: 'MEDIA_NOT_FOUND' });
    await expect(getApiV1MediaId('EXP1')).rejects.toMatchObject({ statusCode: 410, response: { status: 'expired' } });
  });
});
