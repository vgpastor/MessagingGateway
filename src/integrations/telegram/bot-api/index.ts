import type { ProviderBundle } from '../../provider-registry.js';
import { TelegramBotHealthChecker } from './telegram-bot.health-checker.js';
import { AdapterNotFoundError } from '../../../core/errors.js';

export const telegramBotProvider: ProviderBundle = {
  id: 'telegram-bot-api',
  channel: 'telegram',
  displayName: 'Telegram Bot API',
  messaging: () => { throw new AdapterNotFoundError('telegram-bot-api'); },
  health: () => new TelegramBotHealthChecker(),
};
