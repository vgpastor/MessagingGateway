import type { ProviderBundle } from '../../provider-registry.js';
import { BrevoHealthChecker } from './brevo.health-checker.js';
import { AdapterNotFoundError } from '../../../core/errors.js';

export const brevoProvider: ProviderBundle = {
  id: 'brevo',
  channel: 'email',
  displayName: 'Brevo (Sendinblue)',
  messaging: () => { throw new AdapterNotFoundError('brevo'); },
  health: () => new BrevoHealthChecker(),
};
