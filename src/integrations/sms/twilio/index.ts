import type { ProviderBundle } from '../../provider-registry.js';
import { TwilioHealthChecker } from './twilio.health-checker.js';
import { AdapterNotFoundError } from '../../../core/errors.js';

export const twilioProvider: ProviderBundle = {
  id: 'twilio',
  channel: 'sms',
  displayName: 'Twilio',
  messaging: () => { throw new AdapterNotFoundError('twilio'); },
  health: () => new TwilioHealthChecker(),
};
