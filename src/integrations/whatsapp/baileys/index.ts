import type { ProviderBundle } from '../../provider-registry.js';
import { BaileysAdapter } from './baileys.adapter.js';
import { BaileysHealthChecker } from './baileys.health-checker.js';
import { BaileysConnectionManager } from './baileys.connection-manager.js';
import { BaileysWebhookAdapter } from './baileys-webhook.adapter.js';

export const baileysProvider: ProviderBundle = {
  id: 'baileys',
  channel: 'whatsapp',
  displayName: 'WhatsApp (Baileys)',
  messaging: (providerConfig, credentialsRef, inlineCredential) =>
    new BaileysAdapter(providerConfig, credentialsRef, inlineCredential),
  inbound: () => new BaileysWebhookAdapter(),
  health: () => new BaileysHealthChecker(),
  connection: () => new BaileysConnectionManager(),
};
