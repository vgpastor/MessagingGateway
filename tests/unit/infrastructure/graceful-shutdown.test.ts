/**
 * Graceful shutdown: order, limits, and the real inbound pipeline, webhook queue and
 * message log going through it. Only the HTTP server and the webhook endpoint are fakes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebhookForwarder } from '../../../src/connections/webhooks/webhook-forwarder.js';
import { EventBus } from '../../../src/core/event-bus.js';
import { Events } from '../../../src/core/events.js';
import type { MessageInboundPayload } from '../../../src/core/events.js';
import type { ChannelAccount } from '../../../src/core/accounts/channel-account.js';
import { InboundPipeline } from '../../../src/core/inbound/inbound-pipeline.js';
import { noopMediaService } from '../../../src/core/inbound/media-service.js';
import type { UnifiedEnvelope } from '../../../src/core/messaging/unified-envelope.js';
import { noopMetrics } from '../../../src/core/metrics/metrics.port.js';
import type { MessageLogPort } from '../../../src/core/persistence/message-store.port.js';
import type { WebhookConfigRepository } from '../../../src/core/webhooks/webhook-config.repository.js';
import {
  createGracefulShutdown, gatewayShutdownSteps, SHUTDOWN_TOTAL_MS, type GatewayShutdownDeps,
} from '../../../src/infrastructure/graceful-shutdown.js';
import { FailedInboundFile } from '../../../src/persistence/failed-inbound-file.js';
import { SqliteMessageStore } from '../../../src/persistence/sqlite-message-store.js';

describe('createGracefulShutdown', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs the steps in order and exits 0', async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const shutdown = createGracefulShutdown([
      { name: 'a', maxMs: 100, run: async () => { order.push('a'); } },
      { name: 'b', maxMs: 100, run: () => { order.push('b'); } },
    ], { exit });

    await shutdown.run('SIGTERM');

    expect(order).toEqual(['a', 'b']);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('runs once: a second signal is ignored', async () => {
    const run = vi.fn();
    const exit = vi.fn();
    const shutdown = createGracefulShutdown([{ name: 'a', maxMs: 100, run }], { exit });

    expect(shutdown.started).toBe(false);
    await Promise.all([shutdown.run('SIGTERM'), shutdown.run('SIGINT')]);

    expect(shutdown.started).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('a failing step does not stop the next ones, and the exit code says so', async () => {
    const after = vi.fn();
    const exit = vi.fn();
    const shutdown = createGracefulShutdown([
      { name: 'bad', maxMs: 100, run: () => { throw new Error('boom'); } },
      { name: 'after', maxMs: 100, run: after },
    ], { exit });

    await shutdown.run('SIGTERM');

    expect(after).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('a step that hangs only takes its budget', async () => {
    vi.useFakeTimers();
    const after = vi.fn();
    const exit = vi.fn();
    const shutdown = createGracefulShutdown([
      { name: 'hung', maxMs: 2_000, run: () => new Promise(() => {}) },
      { name: 'after', maxMs: 1_000, run: after },
    ], { exit });

    const done = shutdown.run('SIGTERM');
    await vi.advanceTimersByTimeAsync(1_999);
    expect(after).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await done;

    expect(after).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('never goes past the total limit, however many steps hang', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const hung = (name: string) => ({ name, maxMs: 8_000, run: () => new Promise(() => {}) });
    const shutdown = createGracefulShutdown([hung('a'), hung('b'), hung('c')], { exit });

    void shutdown.run('SIGTERM');
    await vi.advanceTimersByTimeAsync(SHUTDOWN_TOTAL_MS - 1);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(exit).toHaveBeenCalledWith(1);
  });

  it('passes each step its budget, cut down when the total limit is closer', async () => {
    vi.useFakeTimers();
    const budgets: number[] = [];
    const shutdown = createGracefulShutdown([
      { name: 'a', maxMs: 400, run: async (ms) => { budgets.push(ms); await new Promise((r) => setTimeout(r, 300)); } },
      { name: 'b', maxMs: 400, run: (ms) => { budgets.push(ms); } },
    ], { totalMs: 500, exit: vi.fn() });

    const done = shutdown.run('SIGTERM');
    await vi.advanceTimersByTimeAsync(300);
    await done;

    expect(budgets).toEqual([400, 200]);
  });
});

describe('gatewayShutdownSteps', () => {
  it('has budgets that add up to the total limit', () => {
    const noop = async () => {};
    const steps = gatewayShutdownSteps({
      server: { close: noop }, stopSchedules: () => {}, closeProviders: noop, inbound: { drain: noop }, webhooks: { drain: noop },
    });
    expect(steps.reduce((sum, step) => sum + step.maxMs, 0)).toBe(SHUTDOWN_TOTAL_MS);
  });

  describe('with the real inbound pipeline, webhook queue and message log', () => {
    const account = { id: 'wa-1', provider: 'baileys' } as ChannelAccount;
    let dir: string;
    let failedPath: string;
    let store: SqliteMessageStore;
    let order: string[];

    function envelope(id: string): UnifiedEnvelope {
      const now = new Date('2026-05-01T10:00:00Z');
      return {
        id,
        accountId: 'wa-1',
        channel: 'whatsapp',
        direction: 'inbound',
        timestamp: now,
        conversationId: 'c@s.whatsapp.net',
        sender: { id: 's@s.whatsapp.net' },
        recipient: { id: '+34600000001' },
        content: { type: 'text', body: id },
        channelDetails: { platform: 'whatsapp', messageId: id },
        gateway: { receivedAt: now, adapterId: 'baileys', account: { id: 'wa-1', alias: 'a', owner: 'o', tags: [] } },
      };
    }

    /** Wires what `main` wires and returns what the shutdown needs. `log` replaces the message log when given. */
    function gateway(log: Pick<MessageLogPort, 'insertInbound'> = store) {
      const eventBus = new EventBus();
      const forwarder = new WebhookForwarder(
        { findByAccountId: async () => [] } as unknown as WebhookConfigRepository, 'https://hook.example.com', undefined,
      );
      eventBus.on<MessageInboundPayload>(Events.MESSAGE_INBOUND, (event) => forwarder.forward(event.data.envelope));
      const pipeline = new InboundPipeline({
        store: log as MessageLogPort,
        failedLog: new FailedInboundFile(failedPath),
        eventBus,
        media: noopMediaService,
        metrics: noopMetrics,
      });
      const deps: GatewayShutdownDeps = {
        server: { close: async () => { order.push('server'); } },
        stopSchedules: () => { order.push('schedules'); },
        closeProviders: async () => { order.push('providers'); },
        inbound: { drain: async (ms) => { order.push('inbound'); await pipeline.drain(ms); } },
        webhooks: { drain: async () => { order.push('webhooks'); await forwarder.drain(); } },
        store: { close: async () => { order.push('store'); await store.close(); } },
      };
      return { pipeline, deps };
    }

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'mg-shutdown-'));
      failedPath = join(dir, 'failed-inbound.jsonl');
      order = [];
      store = new SqliteMessageStore(':memory:');
      await store.init();
      await store.runMigrations();
    });

    afterEach(async () => {
      vi.unstubAllGlobals();
      await store.close();
      await rm(dir, { recursive: true, force: true });
    });

    it('stops requests, closes connections, stores the queue, flushes webhooks and closes the store, in that order', async () => {
      const delivered: string[] = [];
      vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        await new Promise((r) => setTimeout(r, 5));
        delivered.push(JSON.parse(String(init.body)).id);
        return new Response('ok', { status: 200 });
      }));
      const { pipeline, deps } = gateway();
      const exit = vi.fn();
      const insert = vi.spyOn(store, 'insertInbound');

      void pipeline.handle(account, envelope('m1'), {});
      void pipeline.handle(account, envelope('m2'), {});
      await createGracefulShutdown(gatewayShutdownSteps(deps), { exit }).run('SIGTERM');

      expect(order).toEqual(['schedules', 'server', 'providers', 'inbound', 'webhooks', 'store']);
      expect(insert).toHaveBeenCalledTimes(2);
      expect(delivered).toEqual(['m1', 'm2']);
      expect(existsSync(failedPath)).toBe(false);
      expect(exit).toHaveBeenCalledWith(0);
    });

    it('with a store that hangs, what could not be stored ends up in the failed log before exiting', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
      const { pipeline, deps } = gateway({ insertInbound: () => new Promise(() => {}) });
      const exit = vi.fn();

      void pipeline.handle(account, envelope('stuck'), {});
      void pipeline.handle(account, envelope('queued'), {});
      await createGracefulShutdown(gatewayShutdownSteps(deps), { exit }).run('SIGTERM');

      const lines = (await readFile(failedPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line).envelope.id);
      expect(lines).toEqual(['stuck', 'queued']);
      expect(exit).toHaveBeenCalledWith(0);
    }, 8_000);
  });
});
