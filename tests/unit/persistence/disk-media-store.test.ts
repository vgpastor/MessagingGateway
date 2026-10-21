import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, utimes, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DiskMediaStore } from '../../../src/persistence/media/disk-media-store.js';

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

describe('DiskMediaStore', () => {
  let dir: string;
  let store: DiskMediaStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'media-store-'));
    store = new DiskMediaStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes under <dir>/<accountId>/<yyyy-mm>/<mediaId>.<ext> and reads it back', async () => {
    const written = await store.write('wa-1', 'MSG1', 'jpg', Buffer.from('hello'));

    const month = new Date().toISOString().slice(0, 7);
    expect(written.size).toBe(5);
    expect(written.path).toBe(join(dir, 'wa-1', month, 'MSG1.jpg'));

    const opened = await store.open('MSG1');
    expect(opened?.size).toBe(5);
    expect(opened?.mimeType).toBe('image/jpeg');
    expect((await readAll(opened!.stream)).toString()).toBe('hello');
  });

  it('returns undefined for unknown media', async () => {
    expect(await store.open('NOPE')).toBeUndefined();
  });

  it('uses application/octet-stream for unknown extensions', async () => {
    await store.write('wa-1', 'MSG2', 'bin', Buffer.from('x'));
    expect((await store.open('MSG2'))?.mimeType).toBe('application/octet-stream');
  });

  it('keeps hostile account and media ids inside the media directory', async () => {
    const written = await store.write('../../etc', '../../passwd', 'jpg', Buffer.from('x'));

    expect(resolve(written.path).startsWith(resolve(dir) + sep)).toBe(true);
    expect(await store.open('../../passwd')).toBeDefined();
    expect(await store.open('..')).toBeUndefined();
    expect(await store.open('../../../etc/passwd')).toBeUndefined();
  });

  it('purgeOlderThan deletes only files older than the cutoff', async () => {
    const old = await store.write('wa-1', 'OLD', 'jpg', Buffer.from('old'));
    await store.write('wa-1', 'NEW', 'jpg', Buffer.from('new'));
    const longAgo = new Date(Date.now() - 40 * 86_400_000);
    await utimes(old.path, longAgo, longAgo);

    const removed = await store.purgeOlderThan(30);

    expect(removed).toBe(1);
    expect(await store.open('OLD')).toBeUndefined();
    expect(await store.open('NEW')).toBeDefined();
  });

  it('purgeOlderThan removes folders that end up empty', async () => {
    const old = await store.write('wa-1', 'OLD', 'jpg', Buffer.from('old'));
    const longAgo = new Date(Date.now() - 40 * 86_400_000);
    await utimes(old.path, longAgo, longAgo);

    await store.purgeOlderThan(30);

    expect(await readdir(dir)).toEqual([]);
  });

  it('purgeOlderThan on a missing directory removes nothing', async () => {
    expect(await new DiskMediaStore(join(dir, 'does-not-exist')).purgeOlderThan(1)).toBe(0);
  });

  it('concurrent writes of the same media do not clash on a temp file', async () => {
    await Promise.all([
      store.write('wa-1', 'MSG1', 'jpg', Buffer.from('same')),
      store.write('wa-1', 'MSG1', 'jpg', Buffer.from('same')),
      store.write('wa-1', 'MSG1', 'jpg', Buffer.from('same')),
    ]);

    expect(await readdir(join(dir, 'wa-1', new Date().toISOString().slice(0, 7)))).toEqual(['MSG1.jpg']);
  });

  it('does not leave temp files behind', async () => {
    const written = await store.write('wa-1', 'MSG1', 'jpg', Buffer.from('abc'));
    expect((await readFile(written.path)).toString()).toBe('abc');
    expect(await readdir(join(dir, 'wa-1', new Date().toISOString().slice(0, 7)))).toEqual(['MSG1.jpg']);
  });
});
