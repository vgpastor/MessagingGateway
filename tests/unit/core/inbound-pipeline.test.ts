import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../../../src/core/event-bus.js';
import { Events } from '../../../src/core/events.js';
import type { MessageInboundPayload } from '../../../src/core/events.js';
import { InboundPipeline } from '../../../src/core/inbound/inbound-pipeline.js';
import type { MediaService } from '../../../src/core/inbound/media-service.js';
import type { MessageLogPort, InsertResult } from '../../../src/core/persistence/message-store.port.js';
import type { MetricsPort } from '../../../src/core/metrics/metrics.port.js';
import type { ChannelAccount } from '../../../src/core/accounts/channel-account.js';
import type { UnifiedEnvelope } from '../../../src/core/messaging/unified-envelope.js';

function makeAccount(overrides: Partial<ChannelAccount> = {}): ChannelAccount {
  return {
    id: 'wa-1',
    alias: 'WA 1',
    channel: 'whatsapp',
    provider: 'baileys',
    status: 'active',
    identity: { channel: 'whatsapp', phoneNumber: '+34600000001' },
    credentialsRef: '',
    providerConfig: {},
    metadata: { owner: 'org', environment: 'production', tags: [] },
    ...overrides,
  };
}

function makeEnvelope(overrides: Partial<UnifiedEnvelope> = {}): UnifiedEnvelope {
  return {
    id: 'msg_1',
    accountId: 'wa-1',
    channel: 'whatsapp',
    direction: 'inbound',
    timestamp: new Date('2026-04-05T10:00:00Z'),
    conversationId: '34600111222@s.whatsapp.net',
    sender: { id: '34600111222@s.whatsapp.net', phone: '+34600111222' },
    recipient: { id: '+34600000001' },
    content: { type: 'text', body: 'hola' },
    channelDetails: { platform: 'whatsapp', messageId: 'WAID1' },
    gateway: {
      receivedAt: new Date('2026-04-05T10:00:00Z'),
      adapterId: 'baileys',
      account: { id: 'wa-1', alias: 'WA 1', owner: 'org', tags: [] },
    },
    ...overrides,
  };
}

function makeImageEnvelope(): UnifiedEnvelope {
  return makeEnvelope({
    content: { type: 'image', media: { mimeType: 'image/jpeg', base64: 'AAAA', filename: 'a.jpg' } } as UnifiedEnvelope['content'],
  });
}

function setup(opts: {
  insert?: InsertResult | Error | null; // null => storage disabled
  resolveLidToPhone?: (accountId: string, lid: string) => Promise<string | undefined>;
} = {}) {
  const eventBus = new EventBus();
  const emitted: UnifiedEnvelope[] = [];
  eventBus.on<MessageInboundPayload>(Events.MESSAGE_INBOUND, (e) => { emitted.push({ ...e.data.envelope }); });
  const emitSpy = vi.spyOn(eventBus, 'emit');

  const insertInbound = vi.fn(async (): Promise<InsertResult> => {
    if (opts.insert instanceof Error) throw opts.insert;
    return opts.insert ?? { inserted: true, seq: 10, accountSeq: 3 };
  });
  const store = opts.insert === null ? undefined : ({ insertInbound } as unknown as MessageLogPort);
  const media: MediaService = { process: vi.fn(async () => {}), resumePendingMedia: vi.fn(async () => 0) };
  const metrics: MetricsPort = {
    incCounter: vi.fn(), decGauge: vi.fn(), incGauge: vi.fn(), observeHistogram: vi.fn(), persistFailures: vi.fn(),
  };
  const pipeline = new InboundPipeline({ store, eventBus, media, metrics, resolveLidToPhone: opts.resolveLidToPhone });
  return { pipeline, insertInbound, emitSpy, emitted, media, metrics };
}

const raw = { key: { id: 'WAID1' } } as never;

describe('InboundPipeline', () => {
  it('drops status@broadcast', async () => {
    const { pipeline, insertInbound, emitSpy } = setup();

    await pipeline.handle(makeAccount(), makeEnvelope({ conversationId: 'status@broadcast' }), raw, 'notify');

    expect(insertInbound).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('accepts notify and append, ignores other upsert types', async () => {
    const { pipeline, insertInbound } = setup();

    await pipeline.handle(makeAccount(), makeEnvelope(), raw, 'notify');
    await pipeline.handle(makeAccount(), makeEnvelope(), raw, 'append');
    expect(insertInbound).toHaveBeenCalledTimes(2);

    await pipeline.handle(makeAccount(), makeEnvelope(), raw, 'other' as any);
    expect(insertInbound).toHaveBeenCalledTimes(2);
  });

  it('drops conversations outside account allowlist', async () => {
    const { pipeline, insertInbound, emitSpy } = setup();
    const account = makeAccount({ conversations: ['g1@g.us'] });

    await pipeline.handle(account, makeEnvelope({ conversationId: 'g2@g.us' }), raw, 'notify');
    expect(insertInbound).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();

    await pipeline.handle(account, makeEnvelope({ conversationId: 'g1@g.us' }), raw, 'notify');
    expect(insertInbound).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledTimes(1);
  });

  it('accepts every conversation when the allowlist is "*" or absent', async () => {
    const { pipeline, insertInbound } = setup();

    await pipeline.handle(makeAccount({ conversations: '*' }), makeEnvelope(), raw, 'notify');
    await pipeline.handle(makeAccount(), makeEnvelope(), raw, 'notify');

    expect(insertInbound).toHaveBeenCalledTimes(2);
  });

  it('emits after insert with seq and accountSeq', async () => {
    const { pipeline, insertInbound, emitSpy, emitted } = setup({ insert: { inserted: true, seq: 10, accountSeq: 3 } });

    await pipeline.handle(makeAccount(), makeEnvelope(), raw, 'notify');

    expect(emitted).toHaveLength(1);
    expect(emitted[0].seq).toBe(10);
    expect(emitted[0].accountSeq).toBe(3);
    expect(insertInbound.mock.invocationCallOrder[0]).toBeLessThan(emitSpy.mock.invocationCallOrder[0]);
  });

  it('emits MESSAGE_INBOUND for the account with the provider as source', async () => {
    const { pipeline, emitSpy } = setup();

    await pipeline.handle(makeAccount(), makeEnvelope(), raw, 'notify');

    expect(emitSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: Events.MESSAGE_INBOUND, source: 'baileys', accountId: 'wa-1',
    }));
  });

  it('does not emit duplicates', async () => {
    const { pipeline, emitSpy, media } = setup({ insert: { inserted: false } });

    await pipeline.handle(makeAccount(), makeImageEnvelope(), raw, 'notify');

    expect(emitSpy).not.toHaveBeenCalled();
    expect(media.process).not.toHaveBeenCalled();
  });

  it('emits without seq and counts failure when insert throws', async () => {
    const { pipeline, emitted, metrics } = setup({ insert: new Error('db down') });

    await pipeline.handle(makeAccount(), makeEnvelope(), raw, 'notify');

    expect(emitted).toHaveLength(1);
    expect(emitted[0].seq).toBeUndefined();
    expect(emitted[0].accountSeq).toBeUndefined();
    expect(metrics.persistFailures).toHaveBeenCalledTimes(1);
  });

  it('emits directly when storage disabled', async () => {
    const { pipeline, emitted, metrics } = setup({ insert: null });

    await pipeline.handle(makeAccount(), makeEnvelope(), raw, 'notify');

    expect(emitted).toHaveLength(1);
    expect(emitted[0].seq).toBeUndefined();
    expect(metrics.persistFailures).not.toHaveBeenCalled();
  });

  it('passes a storable copy of the raw message to insertInbound', async () => {
    const { pipeline, insertInbound } = setup();
    const msg = { key: { id: 'WAID1' }, message: { imageMessage: { jpegThumbnail: Buffer.alloc(10), directPath: '/p' } } };

    await pipeline.handle(makeAccount(), makeEnvelope(), msg as never, 'notify');

    expect(insertInbound).toHaveBeenCalledWith(expect.anything(), { key: { id: 'WAID1' }, message: { imageMessage: { directPath: '/p' } } });
  });

  it('schedules media after emit', async () => {
    const { pipeline, emitSpy, media } = setup();
    const envelope = makeImageEnvelope();

    await pipeline.handle(makeAccount(), envelope, raw, 'notify');

    expect(media.process).toHaveBeenCalledWith(envelope, raw);
    expect(emitSpy.mock.invocationCallOrder[0]).toBeLessThan((media.process as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]);
  });

  it('marks media as pending and never carries base64 on inbound', async () => {
    const { pipeline, insertInbound, emitted } = setup();

    await pipeline.handle(makeAccount(), makeImageEnvelope(), raw, 'notify');

    const stored = (insertInbound.mock.calls[0] as unknown as [UnifiedEnvelope])[0];
    const media = (stored.content as { media: Record<string, unknown> }).media;
    expect(media.status).toBe('pending');
    expect(media).not.toHaveProperty('base64');
    expect((emitted[0].content as { media: Record<string, unknown> }).media.status).toBe('pending');
  });

  it('does not schedule media for messages without media', async () => {
    const { pipeline, media } = setup();

    await pipeline.handle(makeAccount(), makeEnvelope(), raw, 'notify');

    expect(media.process).not.toHaveBeenCalled();
  });

  it('still schedules media when storage is disabled or insert fails', async () => {
    for (const insert of [null, new Error('boom')]) {
      const { pipeline, media } = setup({ insert });
      await pipeline.handle(makeAccount(), makeImageEnvelope(), raw, 'notify');
      expect(media.process).toHaveBeenCalledTimes(1);
    }
  });

  it('does not let a failing media job break the pipeline', async () => {
    const { pipeline, media } = setup();
    (media.process as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('disk full'));

    await expect(pipeline.handle(makeAccount(), makeImageEnvelope(), raw, 'notify')).resolves.toBeUndefined();
  });

  describe('LID resolution', () => {
    const lidEnvelope = () => makeEnvelope({ sender: { id: '144980999962625@lid', lid: '144980999962625@lid' } });

    it('resolves sender.phone from sender.lid before inserting', async () => {
      const resolveLidToPhone = vi.fn(async () => '34600111222:0@s.whatsapp.net');
      const { pipeline, insertInbound } = setup({ resolveLidToPhone });

      await pipeline.handle(makeAccount(), lidEnvelope(), raw, 'notify');

      expect(resolveLidToPhone).toHaveBeenCalledWith('wa-1', '144980999962625@lid');
      const stored = (insertInbound.mock.calls[0] as unknown as [UnifiedEnvelope])[0];
      expect(stored.sender.phone).toBe('+34600111222');
    });

    it('leaves phone unset when the lid cannot be resolved or the resolver fails', async () => {
      for (const resolveLidToPhone of [vi.fn(async () => undefined), vi.fn(async () => { throw new Error('x'); })]) {
        const { pipeline, emitted } = setup({ resolveLidToPhone });
        await pipeline.handle(makeAccount(), lidEnvelope(), raw, 'notify');
        expect(emitted).toHaveLength(1);
        expect(emitted[0].sender.phone).toBeUndefined();
      }
    });

    it('does not call the resolver when phone is already known or there is no lid', async () => {
      const resolveLidToPhone = vi.fn(async () => '1@s.whatsapp.net');
      const { pipeline } = setup({ resolveLidToPhone });

      await pipeline.handle(makeAccount(), makeEnvelope({ sender: { id: 'x', phone: '+34600111222', lid: 'y@lid' } }), raw, 'notify');
      await pipeline.handle(makeAccount(), makeEnvelope({ sender: { id: 'x' } }), raw, 'notify');

      expect(resolveLidToPhone).not.toHaveBeenCalled();
    });
  });
});
