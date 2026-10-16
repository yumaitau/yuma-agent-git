import { defineConfig, devices } from '@playwright/test';

/**
 * Browser end-to-end tests (issue #80) against `wrangler dev --local`. Run
 * with `npm run test:e2e`, which builds the dashboard first. Kept out of the
 * Vitest suites. Set YAG_E2E_PORT when the default port is taken; the
 * inspector uses the next one.
 */
export const port = Number(process.env.YAG_E2E_PORT ?? 18_690);

export default defineConfig({
  testDir: '.',
  outputDir: 'test-results',
  globalSetup: './global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
  },
});
