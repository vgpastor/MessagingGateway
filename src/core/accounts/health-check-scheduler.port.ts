/**
 * Port for health check scheduling — allows controllers
 * to trigger health checks without infrastructure coupling.
 */
export interface HealthCheckSchedulerPort {
  checkAccount(accountId: string): Promise<void>;
}
