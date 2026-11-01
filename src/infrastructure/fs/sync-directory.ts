import { open } from 'node:fs/promises';
import { getLogger } from '../../core/logger/logger.port.js';

/** Windows cannot flush a directory (EPERM), and NTFS journals the rename anyway. */
const CANNOT_SYNC_A_DIRECTORY = new Set(['EPERM', 'EISDIR', 'EINVAL']);

/**
 * Makes a rename or a new file in `directory` survive a power cut. A failure here costs nothing but
 * that guarantee, and the change is already made: it is logged, and never rejects.
 */
export async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (err) {
    const { code } = err as NodeJS.ErrnoException;
    if (!code || !CANNOT_SYNC_A_DIRECTORY.has(code)) {
      getLogger().warn('Failed to flush a directory', { directory, error: err instanceof Error ? err.message : String(err) });
    }
  }
}
