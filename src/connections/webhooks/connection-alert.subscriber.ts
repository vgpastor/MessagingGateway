import type { EventBus } from '../../core/event-bus.js';
import { Events } from '../../core/events.js';
import type { ConnectionUpdatePayload } from '../../core/events.js';
import { getLogger } from '../../core/logger/logger.port.js';
import type { WebhookForwarder } from './webhook-forwarder.js';

/**
 * Alert when a managed account loses its session (`auth_expired`, e.g. Baileys
 * 401 loggedOut). Until this existed the gateway only logged it, and an account
 * could sit unlinked for days with nobody noticing.
 *
 * The alert goes to the account's webhooks (subscribed to `connection.update`
 * or `*`, else the global callback) and to `alertWebhookUrl` when set. It fires
 * once per transition: further `auth_expired` events are ignored until the
 * account reports `connected` again.
 *
 * ponytail: dedup is in-memory, so a restart with a still-dead session alerts
 * once more — that is the reminder we want, not spam.
 */
export function subscribeConnectionAlerts(
  eventBus: EventBus,
  webhookForwarder: WebhookForwarder,
  alertWebhookUrl?: string,
): void {
  const alerted = new Set<string>();

  eventBus.on<ConnectionUpdatePayload>(Events.CONNECTION_UPDATE, async (event) => {
    const { accountId, status } = event.data;
    if (status === 'connected') {
      alerted.delete(accountId);
      return;
    }
    if (status !== 'auth_expired' || alerted.has(accountId)) return;
    alerted.add(accountId);

    getLogger().warn('Account session lost (auth_expired), sending alert', { accountId, alertWebhookUrl: Boolean(alertWebhookUrl) });

    const payload = {
      ...event.data,
      timestamp: event.timestamp.toISOString(),
      // `text` lets Slack/Mattermost/Google Chat-style incoming webhooks render it as-is.
      text: `MessagingGateway: account '${accountId}' lost its session (auth_expired) and stopped receiving messages. Re-pair it with POST /api/v1/accounts/${accountId}/reset.`,
    };

    await Promise.allSettled([
      webhookForwarder.forwardRaw(accountId, payload, 'connection.update'),
      alertWebhookUrl
        ? webhookForwarder.send(alertWebhookUrl, undefined, accountId, payload, 'connection.update')
        : Promise.resolve(),
    ]);
  });
}
