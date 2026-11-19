import { defineConfig } from 'vitest/config';

/** Unit tests live in src/. The Playwright specs in e2e/ are run by Playwright (`pnpm e2e`), never by Vitest. */
export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**'],
    passWithNoTests: true,
  },
});
