import type { ProviderBundle } from '../../provider-registry.js';
import { TwilioHealthChecker } from './twilio.health-checker.js';

export const twilioProvider: ProviderBundle = {
  id: 'twilio',
  channel: 'sms',
  displayName: 'Twilio',
  messaging: () => { throw new Error('Twilio messaging adapter not yet implemented'); },
  health: () => new TwilioHealthChecker(),
};
