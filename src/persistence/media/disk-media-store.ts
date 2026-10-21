import { createReadStream } from 'node:fs';
import { mkdir, readdir, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mimeTypeForExtension } from '../../core/messaging/media-mime.js';

const DAY_MS = 86_400_000;

/** Keeps a path segment inside the media directory: only `[A-Za-z0-9._-]`, never a dot-only or hidden name. */
function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');
  return cleaned.length > 0 ? cleaned : '_';
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
}

/**
 * Media files on local disk: `<dir>/<accountId>/<yyyy-mm>/<mediaId>.<ext>`.
 * Ids are sanitized, so a hostile account or message id can never escape `dir`.
 */
export class DiskMediaStore {
  constructor(private readonly dir: string) {}

  async write(accountId: string, mediaId: string, ext: string, data: Buffer): Promise<{ path: string; size: number }> {
    const month = new Date().toISOString().slice(0, 7);
    const folder = join(this.dir, safeSegment(accountId), month);
    const path = join(folder, `${safeSegment(mediaId)}.${safeSegment(ext)}`);
    await mkdir(folder, { recursive: true });
    // Write then rename: a crash never leaves a truncated file that `open` would serve.
    const tmp = `${path}.${process.pid}.tmp`;
    try {
      await writeFile(tmp, data);
      await rename(tmp, path);
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
    return { path, size: data.length };
  }

  /**
   * Opens a stored media. Pass the owning `accountId` when known to avoid
   * scanning every account folder.
   */
  async open(mediaId: string, accountId?: string): Promise<{ stream: NodeJS.ReadableStream; size: number; mimeType: string } | undefined> {
    const id = safeSegment(mediaId);
    const accounts = accountId === undefined ? await listDir(this.dir) : [safeSegment(accountId)];
    for (const account of accounts) {
      const accountDir = join(this.dir, account);
      for (const month of (await listDir(accountDir)).sort().reverse()) {
        const monthDir = join(accountDir, month);
        const file = (await listDir(monthDir)).find((name) => name.startsWith(`${id}.`) && !name.endsWith('.tmp') && name.slice(id.length + 1).indexOf('.') === -1);
        if (!file) continue;
        const path = join(monthDir, file);
        try {
          const info = await stat(path);
          if (!info.isFile()) continue;
          return { stream: createReadStream(path), size: info.size, mimeType: mimeTypeForExtension(file.slice(id.length + 1)) };
        } catch (err) {
          if (!isMissing(err)) throw err;
        }
      }
    }
    return undefined;
  }

  /** Deletes files last modified more than `days` ago, and the folders left empty. Returns how many files were removed. */
  async purgeOlderThan(days: number): Promise<number> {
    const cutoff = Date.now() - days * DAY_MS;
    let removed = 0;
    for (const account of await listDir(this.dir)) {
      const accountDir = join(this.dir, account);
      for (const month of await listDir(accountDir)) {
        const monthDir = join(accountDir, month);
        for (const name of await listDir(monthDir)) {
          const path = join(monthDir, name);
          try {
            const info = await stat(path);
            if (info.isFile() && info.mtimeMs < cutoff) {
              await unlink(path);
              removed++;
            }
          } catch (err) {
            if (!isMissing(err)) throw err;
          }
        }
        await this.removeIfEmpty(monthDir);
      }
      await this.removeIfEmpty(accountDir);
    }
    return removed;
  }

  private async removeIfEmpty(dir: string): Promise<void> {
    if ((await listDir(dir)).length === 0) await rmdir(dir).catch(() => undefined);
  }
}
