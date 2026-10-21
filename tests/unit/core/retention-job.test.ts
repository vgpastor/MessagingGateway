import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { runRetention, startRetentionSchedule, RETENTION_INTERVAL_MS } from '../../../src/core/retention/retention-job.js';
import { SqliteMessageStore } from '../../../src/persistence/sqlite-message-store.js';
import { DiskMediaStore } from '../../../src/persistence/media/disk-media-store.js';
import type { UnifiedEnvelope } from '../../../src/core/messaging/unified-envelope.js';

const DAY_MS = 86_400_000;

function envelope(id: string, waId: string, content: UnifiedEnvelope['content']): UnifiedEnvelope {
  const now = new Date('2026-04-05T10:00:00Z');
  return {
    id,
    accountId: 'wa-ret',
    channel: 'whatsapp',
    direction: 'inbound',
    timestamp: now,
    conversationId: '34600000001@s.whatsapp.net',
    sender: { id: '34600000001@s.whatsapp.net' },
    recipient: { id: '+34600000099' },
    content,
    channelDetails: { platform: 'whatsapp', messageId: waId },
    gateway: { receivedAt: now, adapterId: 'baileys', account: { id: 'wa-ret', alias: 'x', owner: 'o', tags: [] } },
  };
}

describe('runRetention', () => {
  describe('with real stores', () => {
    let store: SqliteMessageStore;
    let db: Database;
    let dir: string;
    let files: DiskMediaStore;

    const backdateRow = (id: string, days: number) =>
      db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(new Date(Date.now() - days * DAY_MS).toISOString(), id);

    beforeEach(async () => {
      store = new SqliteMessageStore(':memory:');
      await store.init();
      await store.runMigrations();
      db = (store as unknown as { db: Database }).db;
      dir = await mkdtemp(join(tmpdir(), 'retention-'));
      files = new DiskMediaStore(dir);
    });
    afterEach(async () => {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    });

    it('deletes messages older than messageRetentionDays and media older than mediaRetentionDays, marking purged media expired', async () => {
      // old text (200d) + recent text (1d)
      await store.insertInbound(envelope('msg_old_text', 'W1', { type: 'text', body: 'old' }));
      await store.insertInbound(envelope('msg_new_text', 'W2', { type: 'text', body: 'new' }));
      backdateRow('msg_old_text', 200);
      backdateRow('msg_new_text', 1);

      // media: one 40 days old (past 30d media retention, within 180d message retention), one fresh
      for (const id of ['msg_old_media', 'msg_new_media']) {
        await store.insertInbound(envelope(id, id, { type: 'image', media: { mimeType: 'image/jpeg', status: 'pending' } }));
        const { size } = await files.write('wa-ret', id, 'jpg', Buffer.from(id));
        await store.updateMedia(id, { status: 'ready', size, url: `/api/v1/media/${id}` });
      }
      const oldFile = join(dir, 'wa-ret', new Date().toISOString().slice(0, 7), 'msg_old_media.jpg');
      const longAgo = new Date(Date.now() - 40 * DAY_MS);
      await utimes(oldFile, longAgo, longAgo);
      backdateRow('msg_old_media', 40);

      const result = await runRetention({
        messages: store, media: files, messageRetentionDays: 180, mediaRetentionDays: 30,
      });

      expect(result).toEqual({ messages: 1, media: 1 });
      expect(await store.findById('msg_old_text')).toBeUndefined();
      expect(await store.findById('msg_new_text')).toBeDefined();

      const expired = await store.findById('msg_old_media');
      expect(expired?.content).toMatchObject({ type: 'image', media: { status: 'expired' } });
      expect(await files.open('msg_old_media', 'wa-ret')).toBeUndefined();

      const fresh = await store.findById('msg_new_media');
      expect(fresh?.content).toMatchObject({ media: { status: 'ready' } });
      expect(await files.open('msg_new_media', 'wa-ret')).toBeDefined();
    });
  });

  describe('with fakes', () => {
    const makeDeps = (overrides: Partial<Parameters<typeof runRetention>[0]> = {}) => ({
      messages: { deleteOlderThan: vi.fn().mockResolvedValue(3), updateMedia: vi.fn().mockResolvedValue(undefined) },
      media: { purgeOlderThan: vi.fn().mockResolvedValue(['a', 'b']) },
      messageRetentionDays: 180,
      mediaRetentionDays: 30,
      ...overrides,
    });

    it('passes each retention to its own store and marks every purged id expired', async () => {
      const deps = makeDeps();

      const result = await runRetention(deps);

      expect(deps.media.purgeOlderThan).toHaveBeenCalledWith(30);
      expect(deps.messages.deleteOlderThan).toHaveBeenCalledWith(180);
      expect(deps.messages.updateMedia).toHaveBeenCalledWith('a', { status: 'expired' });
      expect(deps.messages.updateMedia).toHaveBeenCalledWith('b', { status: 'expired' });
      expect(result).toEqual({ messages: 3, media: 2 });
    });

    it.each([0, -1])('messageRetentionDays=%i disables text retention: deleteOlderThan is never called', async (days) => {
      const deps = makeDeps({ messageRetentionDays: days });

      const result = await runRetention(deps);

      expect(deps.messages.deleteOlderThan).not.toHaveBeenCalled();
      expect(result).toEqual({ messages: 0, media: 2 });
    });

    it.each([0, -1])('mediaRetentionDays=%i disables media retention: purgeOlderThan is never called', async (days) => {
      const deps = makeDeps({ mediaRetentionDays: days });

      const result = await runRetention(deps);

      expect(deps.media.purgeOlderThan).not.toHaveBeenCalled();
      expect(deps.messages.updateMedia).not.toHaveBeenCalled();
      expect(result).toEqual({ messages: 3, media: 0 });
    });

    it('both disabled does nothing', async () => {
      const deps = makeDeps({ messageRetentionDays: 0, mediaRetentionDays: 0 });

      expect(await runRetention(deps)).toEqual({ messages: 0, media: 0 });
      expect(deps.messages.deleteOlderThan).not.toHaveBeenCalled();
      expect(deps.media.purgeOlderThan).not.toHaveBeenCalled();
    });

    it('a failing media purge does not stop text retention (and vice versa)', async () => {
      const mediaFails = makeDeps({ media: { purgeOlderThan: vi.fn().mockRejectedValue(new Error('disk')) } });
      expect(await runRetention(mediaFails)).toEqual({ messages: 3, media: 0 });

      const textFails = makeDeps();
      textFails.messages.deleteOlderThan.mockRejectedValue(new Error('db'));
      expect(await runRetention(textFails)).toEqual({ messages: 0, media: 2 });
    });

    it('a failing expiry mark does not stop the remaining ids', async () => {
      const deps = makeDeps({ media: { purgeOlderThan: vi.fn().mockResolvedValue(['a', 'b', 'c']) } });
      deps.messages.updateMedia.mockRejectedValueOnce(new Error('locked'));

      const result = await runRetention(deps);

      expect(deps.messages.updateMedia).toHaveBeenCalledTimes(3);
      expect(result.media).toBe(3);
    });
  });
});

describe('startRetentionSchedule', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const makeDeps = () => ({
    messages: { deleteOlderThan: vi.fn().mockResolvedValue(0), updateMedia: vi.fn().mockResolvedValue(undefined) },
    media: { purgeOlderThan: vi.fn().mockResolvedValue([] as string[]) },
    messageRetentionDays: 180,
    mediaRetentionDays: 30,
  });

  it('runs at startup and then every 24 hours until stopped', async () => {
    const deps = makeDeps();
    const schedule = startRetentionSchedule(deps);

    await vi.advanceTimersByTimeAsync(0);
    expect(deps.media.purgeOlderThan).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(RETENTION_INTERVAL_MS);
    expect(deps.media.purgeOlderThan).toHaveBeenCalledTimes(2);

    schedule.stop();
    await vi.advanceTimersByTimeAsync(RETENTION_INTERVAL_MS * 2);
    expect(deps.media.purgeOlderThan).toHaveBeenCalledTimes(2);
  });

  it('does not block the caller and never rejects when a run throws', async () => {
    const deps = makeDeps();
    deps.media.purgeOlderThan.mockImplementation(() => { throw new Error('sync boom'); });
    deps.messages.deleteOlderThan.mockRejectedValue(new Error('async boom'));

    const schedule = startRetentionSchedule(deps);
    await vi.advanceTimersByTimeAsync(RETENTION_INTERVAL_MS);

    expect(deps.messages.deleteOlderThan).toHaveBeenCalledTimes(2);
    schedule.stop();
  });

  it('skips a tick while the previous run is still in progress', async () => {
    const deps = makeDeps();
    let release!: () => void;
    deps.messages.deleteOlderThan.mockImplementationOnce(() => new Promise<number>((resolve) => { release = () => resolve(0); }));

    const schedule = startRetentionSchedule(deps);
    await vi.advanceTimersByTimeAsync(RETENTION_INTERVAL_MS); // tick fires while the first run hangs
    expect(deps.messages.deleteOlderThan).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(RETENTION_INTERVAL_MS);
    expect(deps.messages.deleteOlderThan).toHaveBeenCalledTimes(2);
    schedule.stop();
  });

  it('unrefs its timer so it never keeps the process alive', () => {
    const unref = vi.fn();
    const spy = vi.spyOn(globalThis, 'setInterval').mockReturnValue({ unref } as unknown as NodeJS.Timeout);
    const schedule = startRetentionSchedule(makeDeps());

    expect(unref).toHaveBeenCalledTimes(1);
    schedule.stop();
    spy.mockRestore();
  });
});
