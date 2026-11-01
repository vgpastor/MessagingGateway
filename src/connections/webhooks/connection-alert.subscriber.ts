import type { ChannelAccountRepository } from '../../core/accounts/channel-account.repository.js';
import type { EventBus, DomainEvent } from '../../core/event-bus.js';
import { Events } from '../../core/events.js';
import type { ConnectionUpdatePayload } from '../../core/events.js';
import { getLogger } from '../../core/logger/logger.port.js';
import type { WebhookForwarder } from './webhook-forwarder.js';

/** How long a dropped connection may stay down before someone is told. */
export const DOWN_ALERT_AFTER_MS = 15 * 60 * 1000;
/** How often the alert repeats, once delivered, while the account stays down. */
export const ALERT_REPEAT_MS = 6 * 60 * 60 * 1000;
/** A connection that lasted less than this was not a recovery. */
const STABLE_CONNECTION_MS = 60_000;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 15 * 60 * 1000;
const CHECK_INTERVAL_MS = 30_000;

/** One stretch of an account being down. */
interface Outage {
  since: number;
  /** The session is lost: no reconnect follows, so it alerts right away. */
  terminal: boolean;
  closeCode?: number;
  /** Connected again since this moment, not long enough yet to call the outage over. */
  upSince?: number;
  nextAlertAt: number;
  failedAttempts: number;
  /** The account's own webhooks hear of an outage once. */
  forwarded: boolean;
  sending: boolean;
}

export interface ConnectionAlertDeps {
  eventBus: EventBus;
  webhookForwarder: WebhookForwarder;
  accounts: Pick<ChannelAccountRepository, 'findById'>;
  alertWebhookUrl?: string;
}

export interface ConnectionAlerts {
  stop(): void;
}

const newOutage = (now: number): Outage => ({ since: now, terminal: false, nextAlertAt: now, failedAttempts: 0, forwarded: false, sending: false });

function alertText(accountId: string, outage: Outage, now: number): string {
  if (outage.terminal) {
    const reason = outage.closeCode === undefined ? '' : `, WhatsApp code ${outage.closeCode}`;
    return `MessagingGateway: account '${accountId}' lost its session (auth_expired${reason}) and stopped receiving messages. Re-pair it with POST /api/v1/accounts/${accountId}/reset.`;
  }
  const minutes = Math.floor((now - outage.since) / 60_000);
  return `MessagingGateway: account '${accountId}' has been disconnected for ${minutes} minutes and is not receiving messages. Check GET /api/v1/accounts/${accountId}.`;
}

/**
 * Tells someone when a managed account goes down: right away if its session is lost
 * (`auth_expired`, e.g. Baileys 401 or 403), after {@link DOWN_ALERT_AFTER_MS} if its connection
 * dropped and has not come back. Until this existed an account could sit dead for days unnoticed.
 *
 * The alert goes to `alertWebhookUrl`, where it counts as delivered only on a 2xx: it is retried
 * with a growing wait until then, and repeats every {@link ALERT_REPEAT_MS} while the account stays
 * down. The account's webhooks subscribed to `connection.update` or `*` (else the global callback)
 * hear of each outage once, best effort.
 *
 * An account waiting for its QR to be scanned, a deliberate disconnect, a deleted account and a
 * suspended one are not outages.
 *
 * ponytail: outages are in memory, so a restart with a still-dead session alerts once
 * more when the connection fails again — that is the reminder we want, not spam.
 */
export function subscribeConnectionAlerts({ eventBus, webhookForwarder, accounts, alertWebhookUrl }: ConnectionAlertDeps): ConnectionAlerts {
  const outages = new Map<string, Outage>();

  if (!alertWebhookUrl) {
    getLogger().warn('ALERT_WEBHOOK_URL is not set: nobody is guaranteed to hear when an account goes down');
  }

  async function deliver(accountId: string, outage: Outage, now: number): Promise<boolean> {
    const payload = {
      accountId,
      status: outage.terminal ? 'auth_expired' : 'disconnected',
      ...(outage.closeCode === undefined ? {} : { closeCode: outage.closeCode }),
      downSince: new Date(outage.since).toISOString(),
      timestamp: new Date(now).toISOString(),
      // `text` lets Slack/Mattermost/Google Chat-style incoming webhooks render it as-is.
      text: alertText(accountId, outage, now),
    };

    if (!outage.forwarded) {
      outage.forwarded = true;
      await webhookForwarder.forwardRaw(accountId, payload, 'connection.update').catch((err: Error) => {
        getLogger().error('Failed to forward a connection alert', { accountId, error: err.message });
      });
    }
    return alertWebhookUrl
      ? webhookForwarder.sendConfirmed(alertWebhookUrl, undefined, accountId, payload, 'connection.update')
      : true;
  }

  async function alertIfDue(accountId: string, outage: Outage): Promise<void> {
    const now = Date.now();
    if (outage.upSince !== undefined || outage.sending || now < outage.nextAlertAt) return;
    if (!outage.terminal && now - outage.since < DOWN_ALERT_AFTER_MS) return;

    outage.sending = true;
    const { terminal } = outage;
    let delivered = false;
    try {
      const account = await accounts.findById(accountId);
      if (!account || account.status === 'suspended') {
        if (outages.get(accountId) === outage) outages.delete(accountId);
        return;
      }
      delivered = await deliver(accountId, outage, now);
    } catch (err) {
      getLogger().error('Failed to send a connection alert', { accountId, error: err instanceof Error ? err.message : String(err) });
    } finally {
      outage.sending = false;
    }

    if (delivered) {
      outage.failedAttempts = 0;
      outage.nextAlertAt = now + ALERT_REPEAT_MS;
      getLogger().warn('Account down, alert sent', { accountId, status: terminal ? 'auth_expired' : 'disconnected', alertWebhookUrl: Boolean(alertWebhookUrl) });
    } else {
      const retryInMs = Math.min(RETRY_BASE_MS * 2 ** outage.failedAttempts, RETRY_MAX_MS);
      outage.failedAttempts += 1;
      outage.nextAlertAt = now + retryInMs;
      getLogger().error('Account down, alert not delivered', { accountId, failedAttempts: outage.failedAttempts, retryInMs });
    }
    // The session was lost while this alert about a dropped connection was on its way: that one still has to go.
    if (outage.terminal !== terminal) outage.nextAlertAt = now;
  }

  function onSessionLost(accountId: string, closeCode: number | undefined, now: number): void {
    const current = outages.get(accountId);
    // Having connected since, however briefly, means a new session was lost: a new outage.
    const outage = current && current.upSince === undefined ? current : newOutage(now);
    outages.set(accountId, outage);
    if (!outage.terminal) {
      outage.terminal = true;
      outage.closeCode = closeCode;
      outage.nextAlertAt = now;
      outage.forwarded = false;
    }
    void alertIfDue(accountId, outage);
  }

  function onDropped(accountId: string, closeCode: number | undefined, now: number): void {
    const current = outages.get(accountId);
    const recovered = current?.upSince !== undefined && now - current.upSince >= STABLE_CONNECTION_MS;
    if (!current || recovered) {
      outages.set(accountId, { ...newOutage(now), closeCode });
      return;
    }
    current.upSince = undefined;
    current.terminal = false;
    current.closeCode = closeCode;
  }

  const onConnectionUpdate = (event: DomainEvent<ConnectionUpdatePayload>): void => {
    const { accountId, status, qr, closeCode, deliberate } = event.data;
    const now = Date.now();

    if (deliberate) {
      outages.delete(accountId);
    } else if (status === 'auth_expired') {
      onSessionLost(accountId, closeCode, now);
    } else if (status === 'connected') {
      const outage = outages.get(accountId);
      if (outage) outage.upSince ??= now;
    } else if (qr) {
      // Waiting for someone to scan it: the connection comes and goes with each QR, and that is fine.
      outages.delete(accountId);
    } else if (status === 'disconnected') {
      onDropped(accountId, closeCode, now);
    }
  };

  eventBus.on<ConnectionUpdatePayload>(Events.CONNECTION_UPDATE, onConnectionUpdate);

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [accountId, outage] of outages) {
      if (outage.upSince !== undefined && now - outage.upSince >= STABLE_CONNECTION_MS) {
        outages.delete(accountId);
      } else {
        void alertIfDue(accountId, outage);
      }
    }
  }, CHECK_INTERVAL_MS);
  timer.unref?.();

  return {
    stop() {
      clearInterval(timer);
      eventBus.off(Events.CONNECTION_UPDATE, onConnectionUpdate as (event: DomainEvent) => void);
    },
  };
}
