import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventBus } from '../../../src/core/event-bus.js';
import { Events, createEvent } from '../../../src/core/events.js';
import type { ConnectionUpdatePayload } from '../../../src/core/events.js';
import type { ChannelAccount } from '../../../src/core/accounts/channel-account.js';
import type { WebhookConfig } from '../../../src/core/webhooks/webhook-config.js';
import type { WebhookConfigRepository } from '../../../src/core/webhooks/webhook-config.repository.js';
import { WebhookForwarder } from '../../../src/connections/webhooks/webhook-forwarder.js';
import { subscribeConnectionAlerts, type ConnectionAlerts } from '../../../src/connections/webhooks/connection-alert.subscriber.js';

const ALERT_URL = 'https://alerts.test/hook';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** The monitor looks every 30 s, so a deadline is noticed within this margin. */
const NOTICE = 30_000;

describe('connection alerts', () => {
  const fetchSpy = vi.fn();
  const accounts = new Map<string, Partial<ChannelAccount>>();
  let accountHooks: WebhookConfig[] = [];
  let eventBus: EventBus;
  let alerts: ConnectionAlerts;

  const toAlertUrl = () => fetchSpy.mock.calls.filter(([url]) => url === ALERT_URL);
  const alertBodies = () => toAlertUrl().map(([, init]) => JSON.parse((init as RequestInit).body as string) as Record<string, unknown>);
  const answer = (status: number) => fetchSpy.mockImplementation(async () => new Response(null, { status }));

  function start(alertWebhookUrl: string | undefined = ALERT_URL): void {
    const repo = { findByAccountId: async () => accountHooks } as unknown as WebhookConfigRepository;
    alerts = subscribeConnectionAlerts({
      eventBus,
      webhookForwarder: new WebhookForwarder(repo, undefined, undefined),
      accounts: { findById: async (id) => accounts.get(id) as ChannelAccount | undefined },
      alertWebhookUrl,
    });
  }

  async function report(data: Omit<ConnectionUpdatePayload, 'accountId'>, accountId = 'wa-1'): Promise<void> {
    await eventBus.emit(createEvent<ConnectionUpdatePayload>(Events.CONNECTION_UPDATE, 'baileys', { accountId, ...data }, accountId));
    await vi.advanceTimersByTimeAsync(0);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    fetchSpy.mockReset();
    answer(200);
    vi.stubGlobal('fetch', fetchSpy);
    accounts.clear();
    accounts.set('wa-1', { id: 'wa-1', status: 'active' });
    accountHooks = [];
    eventBus = new EventBus();
  });

  afterEach(() => {
    alerts.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('a lost session', () => {
    it('alerts right away, with its reason and without the QR', async () => {
      start();

      await report({ status: 'auth_expired', closeCode: 403, qr: 'SECRET-QR' });

      expect(alertBodies()).toEqual([expect.objectContaining({ accountId: 'wa-1', status: 'auth_expired', closeCode: 403 })]);
      expect(alertBodies()[0]!['text']).toContain('wa-1');
      expect(JSON.stringify(alertBodies())).not.toContain('SECRET-QR');
    });

    it('does not alert twice for the same loss', async () => {
      start();

      await report({ status: 'auth_expired' });
      await report({ status: 'auth_expired' });
      await vi.advanceTimersByTimeAsync(HOUR);

      expect(toAlertUrl()).toHaveLength(1);
    });

    it('repeats every 6 hours while the account stays down', async () => {
      start();
      await report({ status: 'auth_expired' });

      await vi.advanceTimersByTimeAsync(6 * HOUR - NOTICE);
      expect(toAlertUrl()).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(NOTICE);
      expect(toAlertUrl()).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(6 * HOUR);
      expect(toAlertUrl()).toHaveLength(3);
    });

    it('alerts again if a re-paired account loses the session again', async () => {
      start();
      await report({ status: 'auth_expired' });
      await report({ status: 'connected' });

      await report({ status: 'auth_expired' });

      expect(toAlertUrl()).toHaveLength(2);
    });
  });

  describe('an alert that does not arrive', () => {
    it.each([
      ['a non-2xx answer', () => answer(500)],
      ['a network error', () => fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'))],
    ])('after %s, keeps retrying with growing waits until a 2xx, and only then waits 6 hours', async (_case, fail) => {
      fail();
      start();
      await report({ status: 'auth_expired' });
      expect(toAlertUrl()).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(toAlertUrl()).toHaveLength(2);

      // The second wait is longer: nothing goes out where the first interval would have repeated.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(toAlertUrl()).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(toAlertUrl()).toHaveLength(3);

      answer(200);
      await vi.advanceTimersByTimeAsync(2 * MINUTE);
      expect(toAlertUrl()).toHaveLength(4);

      await vi.advanceTimersByTimeAsync(5 * HOUR);
      expect(toAlertUrl()).toHaveLength(4);
    });

    it('never waits more than 15 minutes between retries', async () => {
      answer(500);
      start();
      await report({ status: 'auth_expired' });
      await vi.advanceTimersByTimeAsync(2 * HOUR);
      const before = toAlertUrl().length;

      await vi.advanceTimersByTimeAsync(15 * MINUTE + NOTICE);

      expect(toAlertUrl().length).toBeGreaterThan(before);
    });

    it('stops retrying once the account is back', async () => {
      answer(500);
      start();
      await report({ status: 'auth_expired' });
      await report({ status: 'connected' });

      await vi.advanceTimersByTimeAsync(HOUR);

      expect(toAlertUrl()).toHaveLength(1);
    });
  });

  describe('a dropped connection', () => {
    it('alerts only after 15 minutes down', async () => {
      start();
      await report({ status: 'disconnected', closeCode: 428 });

      await vi.advanceTimersByTimeAsync(15 * MINUTE - NOTICE);
      expect(toAlertUrl()).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(NOTICE);
      expect(alertBodies()).toEqual([expect.objectContaining({ accountId: 'wa-1', status: 'disconnected' })]);
    });

    it('does not alert if it comes back in time', async () => {
      start();
      await report({ status: 'disconnected' });
      await vi.advanceTimersByTimeAsync(14 * MINUTE);

      await report({ status: 'connected' });
      await vi.advanceTimersByTimeAsync(HOUR);

      expect(toAlertUrl()).toHaveLength(0);
    });

    it('keeps the clock through a connection that opens and drops: a flapping account is still down', async () => {
      start();
      await report({ status: 'disconnected' });
      for (let elapsed = 0; elapsed < 15 * MINUTE + NOTICE; elapsed += MINUTE) {
        await vi.advanceTimersByTimeAsync(MINUTE - 10_000);
        await report({ status: 'connected' });
        await vi.advanceTimersByTimeAsync(10_000);
        await report({ status: 'disconnected', closeCode: 440 });
      }

      expect(toAlertUrl()).toHaveLength(1);
    });

    it('starts over after a connection that held for 60 s', async () => {
      start();
      await report({ status: 'disconnected' });
      await vi.advanceTimersByTimeAsync(10 * MINUTE);
      await report({ status: 'connected' });
      await vi.advanceTimersByTimeAsync(MINUTE);

      await report({ status: 'disconnected' });
      await vi.advanceTimersByTimeAsync(10 * MINUTE);

      expect(toAlertUrl()).toHaveLength(0);
    });

    it('updates that do not change anything do not restart the 60 s', async () => {
      start();
      await report({ status: 'disconnected' });
      await report({ status: 'connected' });
      await vi.advanceTimersByTimeAsync(30_000);
      await report({ status: 'connected' }); // e.g. Baileys' receivedPendingNotifications
      await vi.advanceTimersByTimeAsync(30_000);

      await report({ status: 'disconnected' });
      await vi.advanceTimersByTimeAsync(14 * MINUTE);

      expect(toAlertUrl()).toHaveLength(0);
    });

    it('becoming a lost session alerts right away, even if the drop was already alerted', async () => {
      start();
      await report({ status: 'disconnected' });
      await vi.advanceTimersByTimeAsync(15 * MINUTE + NOTICE);
      expect(toAlertUrl()).toHaveLength(1);

      await report({ status: 'auth_expired' });

      expect(alertBodies().map((b) => b['status'])).toEqual(['disconnected', 'auth_expired']);
    });
  });

  describe('what is not an outage', () => {
    it('an account waiting for its QR to be scanned', async () => {
      start();
      await report({ status: 'connecting', qr: 'QR' });
      await report({ status: 'disconnected', qr: 'QR', closeCode: 408 });

      await vi.advanceTimersByTimeAsync(HOUR);

      expect(toAlertUrl()).toHaveLength(0);
    });

    it('a reset that shows a QR ends the reminders of a lost session', async () => {
      start();
      await report({ status: 'auth_expired' });

      await report({ status: 'connecting', qr: 'QR' });
      await vi.advanceTimersByTimeAsync(7 * HOUR);

      expect(toAlertUrl()).toHaveLength(1);
    });

    it('a deliberate disconnect, which also ends the reminders', async () => {
      start();
      await report({ status: 'auth_expired' });

      await report({ status: 'disconnected', deliberate: true });
      await vi.advanceTimersByTimeAsync(7 * HOUR);

      expect(toAlertUrl()).toHaveLength(1);
    });

    it('an account that was deleted', async () => {
      start();
      await report({ status: 'disconnected' });
      accounts.delete('wa-1');

      await vi.advanceTimersByTimeAsync(HOUR);

      expect(toAlertUrl()).toHaveLength(0);
    });

    it('a suspended account, not even when it loses its session', async () => {
      accounts.set('wa-1', { id: 'wa-1', status: 'suspended' });
      start();

      await report({ status: 'auth_expired' });
      await vi.advanceTimersByTimeAsync(HOUR);

      expect(toAlertUrl()).toHaveLength(0);
    });
  });

  describe("the account's own webhooks", () => {
    const hook: WebhookConfig = {
      id: 'wh_1', accountId: 'wa-1', url: 'https://crm.test/hook', events: ['connection.update'], enabled: true,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    };
    const toHook = () => fetchSpy.mock.calls.filter(([url]) => url === hook.url);

    it('hear of an outage once, whatever retries and reminders go to the alert URL', async () => {
      accountHooks = [hook];
      answer(500);
      start();

      await report({ status: 'auth_expired' });
      await vi.advanceTimersByTimeAsync(7 * HOUR);

      expect(toAlertUrl().length).toBeGreaterThan(1);
      expect(toHook()).toHaveLength(1);
    });

    it('are the only destination without ALERT_WEBHOOK_URL', async () => {
      accountHooks = [hook];
      start('');

      await report({ status: 'auth_expired' });
      await vi.advanceTimersByTimeAsync(7 * HOUR);

      expect(toHook()).toHaveLength(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  it('stops looking when stopped', async () => {
    start();
    await report({ status: 'disconnected' });

    alerts.stop();
    await vi.advanceTimersByTimeAsync(HOUR);

    expect(toAlertUrl()).toHaveLength(0);
  });
});
