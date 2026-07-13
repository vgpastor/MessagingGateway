import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { BaileysSocketManager } from '../../../src/integrations/whatsapp/baileys/baileys-socket.manager.js';

const ACCOUNT_ID = 'test-clear-session';
const authDir = resolve(process.cwd(), 'data', 'baileys-auth', ACCOUNT_ID);

describe('BaileysSocketManager.clearSession', () => {
  afterEach(async () => {
    await rm(authDir, { recursive: true, force: true });
  });

  it('deletes the on-disk auth dir so the next connect starts fresh', async () => {
    const manager = new BaileysSocketManager();
    await mkdir(authDir, { recursive: true });
    await writeFile(resolve(authDir, 'creds.json'), '{}');
    expect(existsSync(authDir)).toBe(true);

    await manager.clearSession(ACCOUNT_ID, {});

    expect(existsSync(authDir)).toBe(false);
  });

  it('refuses to delete an auth dir outside the managed root (path traversal)', async () => {
    const manager = new BaileysSocketManager();

    await expect(
      manager.clearSession('evil', { authDir: '../../../tmp/evil' }),
    ).rejects.toMatchObject({ code: 'INVALID_AUTH_DIR' });
  });
});
