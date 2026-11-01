/**
 * The Postgres the tests run against. Without one they are skipped, which is fine on a laptop. In CI
 * it would turn a broken service definition into a green run that tested no Postgres at all, so it fails.
 */
export function testDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.CI && !env.TEST_DATABASE_URL) {
    throw new Error('TEST_DATABASE_URL is required in CI: the Postgres tests must not be skipped');
  }
  return env.TEST_DATABASE_URL;
}
