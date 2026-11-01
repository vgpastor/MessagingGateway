import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The first server a test file builds is a cold start (imports, swagger): 1 s alone, over 5 s with every file in parallel.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
