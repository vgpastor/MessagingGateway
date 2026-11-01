/**
 * What `keepOnly` asks of the disk, which a test cannot see from the outcome: the temporary file is flushed
 * before it replaces the log, and the directory after, so a power cut leaves one whole file or the other.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { UnifiedEnvelope } from '../../../src/core/messaging/unified-envelope.js';

const calls: string[] = [];

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    open: async (path: string, flags: string) => {
      const handle = await real.open(path, flags);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        calls.push(`sync ${path}`);
        await sync();
      };
      return handle;
    },
    rename: async (from: string, to: string) => {
      calls.push(`rename ${from}`);
      await real.rename(from, to);
    },
  };
});

const { FailedInboundFile } = await import('../../../src/persistence/failed-inbound-file.js');

function envelope(id: string): UnifiedEnvelope {
  return { id, accountId: 'wa-1', gateway: { receivedAt: new Date() }, timestamp: new Date() } as unknown as UnifiedEnvelope;
}

describe('FailedInboundFile durability', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mg-failed-sync-'));
    calls.length = 0;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('flushes the temporary file before the rename and the directory after it', async () => {
    const path = join(dir, 'failed-inbound.jsonl');
    const file = new FailedInboundFile(path);
    await file.append({ envelope: envelope('saved'), raw: undefined });
    await file.append({ envelope: envelope('kept'), raw: undefined });
    calls.length = 0;

    await file.replay(async (entry) => {
      if (entry.envelope.id === 'kept') throw new Error('still failing');
    });

    expect(calls).toEqual([`sync ${path}.tmp`, `rename ${path}.tmp`, `sync ${dirname(path)}`]);
  });
});
