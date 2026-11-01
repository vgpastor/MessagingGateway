import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FailedInboundEntry, FailedInboundLog } from '../core/inbound/failed-inbound-log.js';
import { getLogger } from '../core/logger/logger.port.js';
import type { UnifiedEnvelope } from '../core/messaging/unified-envelope.js';

function parseEntry(line: string): FailedInboundEntry {
  const { envelope, raw } = JSON.parse(line) as { envelope: UnifiedEnvelope; raw?: unknown };
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

/** {@link FailedInboundLog} on a JSON Lines file: one entry per line, flushed to disk before `append` resolves. */
export class FailedInboundFile implements FailedInboundLog {
  constructor(private readonly path: string) {}

  async append(entry: FailedInboundEntry): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const file = await open(this.path, 'a');
    try {
      await file.appendFile(`${JSON.stringify(entry)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
  }

  async replay(save: (entry: FailedInboundEntry) => Promise<void>): Promise<{ saved: number; kept: number }> {
    const lines = await this.readLines();
    const kept: string[] = [];
    for (const line of lines) {
      try {
        await save(parseEntry(line));
      } catch (err) {
        kept.push(line);
        getLogger().error('Failed inbound entry not stored', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    const saved = lines.length - kept.length;
    if (saved > 0) await this.keepOnly(kept);
    return { saved, kept: kept.length };
  }

  private async readLines(): Promise<string[]> {
    try {
      return (await readFile(this.path, 'utf8')).split('\n').filter((line) => line.trim() !== '');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  /** Write then rename: a crash here leaves the old file, and saving those entries again is a no-op. */
  private async keepOnly(lines: string[]): Promise<void> {
    if (lines.length === 0) {
      await rm(this.path, { force: true });
      return;
    }
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, `${lines.join('\n')}\n`);
    await rename(tmp, this.path);
  }
}
