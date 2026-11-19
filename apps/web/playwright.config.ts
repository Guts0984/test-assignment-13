import { defineConfig } from '@playwright/test';

/** e2e runs against the REAL docker compose stack (nginx on :8080), not a mock. */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  retries: 1,
  workers: 1,
  use: {
    baseURL: process.env['E2E_BASE_URL'] ?? 'http://localhost:8080',
    trace: 'retain-on-failure',
  },
  reporter: [['list']],
});
