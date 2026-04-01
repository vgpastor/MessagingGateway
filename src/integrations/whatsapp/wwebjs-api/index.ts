import type { ProviderBundle } from '../../provider-registry.js';
import { WwebjsApiAdapter } from './wwebjs.adapter.js';
import { WwebjsHealthChecker } from './wwebjs.health-checker.js';
import { WwebjsWebhookAdapter } from './wwebjs-webhook.adapter.js';

export const wwebjsProvider: ProviderBundle = {
  id: 'wwebjs-api',
  channel: 'whatsapp',
  displayName: 'WhatsApp (wwebjs-api)',
  messaging: (config: Record<string, unknown>, cred: string, inline?: string) =>
    new WwebjsApiAdapter(config, cred, inline),
  inbound: () => new WwebjsWebhookAdapter(),
  health: () => new WwebjsHealthChecker(),
};
