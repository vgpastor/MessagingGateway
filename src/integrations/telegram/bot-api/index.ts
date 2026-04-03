import type { ProviderBundle } from '../../provider-registry.js';
import { TelegramBotAdapter } from './telegram-bot.adapter.js';
import { TelegramBotInboundAdapter } from './telegram-bot.inbound.js';
import { TelegramBotHealthChecker } from './telegram-bot.health-checker.js';

export const telegramBotProvider: ProviderBundle = {
  id: 'telegram-bot-api',
  channel: 'telegram',
  displayName: 'Telegram Bot API',
  messaging: (config, cred, inline) => new TelegramBotAdapter(config, cred, inline),
  inbound: () => new TelegramBotInboundAdapter(),
  health: () => new TelegramBotHealthChecker(),
};
