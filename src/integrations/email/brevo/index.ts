import type { ProviderBundle } from '../../provider-registry.js';
import { BrevoHealthChecker } from './brevo.health-checker.js';

export const brevoProvider: ProviderBundle = {
  id: 'brevo',
  channel: 'email',
  displayName: 'Brevo (Sendinblue)',
  messaging: () => { throw new Error('Brevo messaging adapter not yet implemented'); },
  health: () => new BrevoHealthChecker(),
};
