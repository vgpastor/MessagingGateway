import type { ProviderBundle } from '../../provider-registry.js';
import { WwebjsApiAdapter } from './wwebjs.adapter.js';
import { WwebjsHealthChecker } from './wwebjs.health-checker.js';
import { WwebjsWebhookAdapter } from './wwebjs-webhook.adapter.js';

export const wwebjsProvider: ProviderBundle = {
  id: 'wwebjs-api',
  channel: 'whatsapp',
  displayName: 'WhatsApp (wwebjs-api)',
  messaging: (providerConfig, credentialsRef, inlineCredential) =>
    new WwebjsApiAdapter(providerConfig, credentialsRef, inlineCredential),
  inbound: () => new WwebjsWebhookAdapter(),
  health: () => new WwebjsHealthChecker(),
};
