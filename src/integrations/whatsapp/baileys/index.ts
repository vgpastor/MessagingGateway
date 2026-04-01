import type { ProviderBundle } from '../../provider-registry.js';
import { BaileysAdapter } from './baileys.adapter.js';
import { BaileysHealthChecker } from './baileys.health-checker.js';
import { BaileysConnectionManager } from './baileys.connection-manager.js';
import { BaileysWebhookAdapter } from './baileys-webhook.adapter.js';

export const baileysProvider: ProviderBundle = {
  id: 'baileys',
  channel: 'whatsapp',
  displayName: 'WhatsApp (Baileys)',
  messaging: (config: Record<string, unknown>, cred: string, inline?: string) =>
    new BaileysAdapter(config, cred, inline),
  inbound: () => new BaileysWebhookAdapter(),
  health: () => new BaileysHealthChecker(),
  connection: () => new BaileysConnectionManager(),
};
