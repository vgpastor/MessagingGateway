import type { ProviderBundle } from '../../provider-registry.js';
import { MessageBirdHealthChecker } from './messagebird.health-checker.js';
import { AdapterNotFoundError } from '../../../core/errors.js';

export const messagebirdProvider: ProviderBundle = {
  id: 'messagebird',
  channel: 'sms',
  displayName: 'MessageBird',
  messaging: () => { throw new AdapterNotFoundError('messagebird'); },
  health: () => new MessageBirdHealthChecker(),
};
