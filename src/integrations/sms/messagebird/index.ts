import type { ProviderBundle } from '../../provider-registry.js';
import { MessageBirdHealthChecker } from './messagebird.health-checker.js';

export const messagebirdProvider: ProviderBundle = {
  id: 'messagebird',
  channel: 'sms',
  displayName: 'MessageBird',
  messaging: () => { throw new Error('MessageBird messaging adapter not yet implemented'); },
  health: () => new MessageBirdHealthChecker(),
};
