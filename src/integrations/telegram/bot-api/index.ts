import type { ProviderBundle } from '../../provider-registry.js';
import { TelegramBotHealthChecker } from './telegram-bot.health-checker.js';

export const telegramBotProvider: ProviderBundle = {
  id: 'telegram-bot-api',
  channel: 'telegram',
  displayName: 'Telegram Bot API',
  messaging: () => { throw new Error('Telegram messaging adapter not yet implemented'); },
  health: () => new TelegramBotHealthChecker(),
};
