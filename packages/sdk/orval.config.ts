import { defineConfig } from 'orval';

export default defineConfig({
  gateway: {
    input: {
      target: '../../openapi.json',
    },
    output: {
      mode: 'single',
      target: './src/generated/api.ts',
      client: 'fetch',
      httpClient: 'fetch',
      baseUrl: false, // User provides baseUrl at runtime
      override: {
        mutator: {
          path: './src/fetch-mutator.ts',
          name: 'customFetch',
        },
      },
    },
  },
});
