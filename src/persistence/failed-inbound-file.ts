import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PermanentStoreError } from '../core/errors.js';
import type { FailedInboundEntry, FailedInboundLog, FailedInboundReplay } from '../core/inbound/failed-inbound-log.js';
import { getLogger } from '../core/logger/logger.port.js';
import type { UnifiedEnvelope } from '../core/messaging/unified-envelope.js';
import { syncDirectory } from '../infrastructure/fs/sync-directory.js';

function parseEntry(line: string): FailedInboundEntry {
  const { envelope, raw } = JSON.parse(line) as { envelope: UnifiedEnvelope; raw?: unknown };
  // What a LID's wait is measured from: without it, the entry could wait for ever.
  if (Number.isNaN(new Date(envelope.gateway.receivedAt).getTime())) throw new RangeError('gateway.receivedAt is not a date');
  return {
    envelope: {
      ...envelope,
      timestamp: new Date(envelope.timestamp),
      ...(envelope.sentAt ? { sentAt: new Date(envelope.sentAt) } : {}),
      gateway: { ...envelope.gateway, receivedAt: new Date(envelope.gateway.receivedAt) },
    },
    raw,
  };
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A crash halfway through an append leaves a last line with no end, and whatever came next would be glued to it. */
async function endsCutShort(file: FileHandle): Promise<boolean> {
  const { size } = await file.stat();
  if (size === 0) return false;
  const { buffer } = await file.read(Buffer.alloc(1), 0, 1, size - 1);
  return buffer[0] !== 0x0a;
}

/** A line on its way to the rejected file, as it was in the log: it may not even be JSON. */
interface RejectedLine {
  line: string;
  reason: string;
}

/**
 * {@link FailedInboundLog} on a JSON Lines file: one entry per line, flushed to disk before `append` resolves.
 * What is rejected goes to `<name>.rejected.jsonl` next to it, for someone to look at, each original line under `line`.
 */
export class FailedInboundFile implements FailedInboundLog {
  /** Tail of the operations on the file. Saving an entry is not one of them: an append never waits for a replay's saves. */
  private fileTurn: Promise<unknown> = Promise.resolve();
  /** Tail of the replays. */
  private replayTurn: Promise<unknown> = Promise.resolve();

  private readonly rejectedPath: string;

  constructor(private readonly path: string) {
    this.rejectedPath = path.replace(/(\.jsonl)?$/, '.rejected.jsonl');
  }

  append(entry: FailedInboundEntry): Promise<void> {
    const line = `${JSON.stringify(entry)}\n`;
    return this.onFile(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const file = await open(this.path, 'a+');
      try {
        await file.appendFile(await endsCutShort(file) ? `\n${line}` : line);
        await file.sync();
      } finally {
        await file.close();
      }
    });
  }

  replay(save: (entry: FailedInboundEntry) => Promise<void>): Promise<FailedInboundReplay> {
    const run = this.replayTurn.then(() => this.replayOnce(save));
    this.replayTurn = run.catch(() => {});
    return run;
  }

  private async replayOnce(save: (entry: FailedInboundEntry) => Promise<void>): Promise<FailedInboundReplay> {
    const { lines, size } = await this.onFile(() => this.read());
    const kept: string[] = [];
    const rejected: RejectedLine[] = [];
    let firstFailure: unknown;
    for (const line of lines) {
      let entry: FailedInboundEntry;
      try {
        entry = parseEntry(line);
      } catch (err) {
        rejected.push({ line, reason: `it cannot be read: ${errorMessage(err)}` });
        continue;
      }
      try {
        await save(entry);
      } catch (err) {
        if (err instanceof PermanentStoreError) {
          rejected.push({ line, reason: err.message });
        } else {
          if (kept.length === 0) firstFailure = err;
          kept.push(line);
        }
      }
    }

    if (kept.length > 0) getLogger().warn('Inbound messages remain in the failed log', { kept: kept.length, error: errorMessage(firstFailure) });
    const saved = lines.length - kept.length - rejected.length;
    // In this order: a crash between the two leaves the entry in both files, and it is rejected again.
    if (rejected.length > 0) await this.onFile(() => this.reject(rejected));
    if (saved + rejected.length > 0) await this.onFile(() => this.keepOnly(kept, size));
    return { saved, kept: kept.length, rejected: rejected.length };
  }

  private async reject(rejected: RejectedLine[]): Promise<void> {
    const rejectedAt = new Date().toISOString();
    const content = rejected.map(({ line, reason }) => `${JSON.stringify({ rejectedAt, reason, line })}\n`).join('');
    const file = await open(this.rejectedPath, 'a');
    try {
      await file.appendFile(content);
      await file.sync();
    } finally {
      await file.close();
    }
    await syncDirectory(dirname(this.path));
    for (const { reason } of rejected) {
      getLogger().error('Inbound entry moved to the rejected log: it will not be stored', { path: this.rejectedPath, reason });
    }
  }

  private onFile<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.fileTurn.then(operation);
    this.fileTurn = run.catch(() => {});
    return run;
  }

  private async read(): Promise<{ lines: string[]; size: number }> {
    try {
      const content = await readFile(this.path);
      return { lines: content.toString('utf8').split('\n').filter((line) => line.trim() !== ''), size: content.length };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { lines: [], size: 0 };
      throw err;
    }
  }

  /**
   * Leaves `lines` plus whatever was appended past the `replayedSize` bytes the replay read. Write, flush, rename,
   * flush the directory: a crash at any point leaves the old file whole, and saving those entries again is a no-op.
   */
  private async keepOnly(lines: string[], replayedSize: number): Promise<void> {
    const arrived = (await readFile(this.path)).subarray(replayedSize);
    if (lines.length === 0 && arrived.length === 0) {
      await rm(this.path, { force: true });
      return;
    }
    const tmp = `${this.path}.tmp`;
    const file = await open(tmp, 'w');
    try {
      await file.writeFile(Buffer.concat([Buffer.from(lines.map((line) => `${line}\n`).join('')), arrived]));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tmp, this.path);
    await syncDirectory(dirname(this.path));
  }
}
