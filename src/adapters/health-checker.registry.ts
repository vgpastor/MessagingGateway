import type { ProviderType } from '../domain/messaging/channel.types.js';
import type { ProviderHealthChecker } from '../domain/messaging/provider-health.port.js';

export class HealthCheckerRegistry {
  private registry = new Map<ProviderType, ProviderHealthChecker>();

  register(provider: ProviderType, checker: ProviderHealthChecker): void {
    this.registry.set(provider, checker);
  }

  get(provider: ProviderType): ProviderHealthChecker | undefined {
    return this.registry.get(provider);
  }

  has(provider: ProviderType): boolean {
    return this.registry.has(provider);
  }
}
