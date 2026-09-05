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

  it('keeps the inbound subscriptions so a re-paired account still delivers messages', async () => {
    const manager = new BaileysSocketManager();
    await mkdir(authDir, { recursive: true });
    await writeFile(resolve(authDir, 'creds.json'), '{}');

    manager.onMessage(ACCOUNT_ID, () => {});

    await manager.clearSession(ACCOUNT_ID, {});

    // The socket is gone, but the account's handler must survive the teardown:
    // the reconnect that follows a reset re-creates the entry from scratch.
    expect(handlersFor(manager, ACCOUNT_ID)).toHaveLength(1);
  });
});

describe('BaileysSocketManager subscriptions', () => {
  it('accepts a handler registered before the first connect', () => {
    const manager = new BaileysSocketManager();

    manager.onMessage('never-connected', () => {});
    manager.onConnectionUpdate('never-connected', () => {});

    expect(handlersFor(manager, 'never-connected')).toHaveLength(1);
    expect(connectionHandlersFor(manager, 'never-connected')).toHaveLength(1);
  });

  it('drops the subscriptions once the device is unlinked', async () => {
    const manager = new BaileysSocketManager();
    manager.onMessage('gone', () => {});

    await manager.disconnect('gone');

    expect(handlersFor(manager, 'gone')).toHaveLength(0);
  });
});

/** The registries are private state; reach in rather than exposing them just for tests. */
function handlersFor(manager: BaileysSocketManager, accountId: string): unknown[] {
  const registry = (manager as unknown as { messageHandlers: Map<string, unknown[]> }).messageHandlers;
  return registry.get(accountId) ?? [];
}

function connectionHandlersFor(manager: BaileysSocketManager, accountId: string): unknown[] {
  const registry = (manager as unknown as { connectionHandlers: Map<string, unknown[]> }).connectionHandlers;
  return registry.get(accountId) ?? [];
}
