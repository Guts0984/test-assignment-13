import { defineConfig } from 'orval';

/** The API client is GENERATED from the server's OpenAPI document. Nothing in src/shared/api/generated is hand-written. */
export default defineConfig({
  auction: {
    input: '../api/openapi.json',
    output: {
      target: 'src/shared/api/generated/client.ts',
      client: 'react-query',
      mode: 'single',
      override: { mutator: { path: 'src/shared/api/fetcher.ts', name: 'apiFetch' } },
      clean: true,
    },
  },
});
