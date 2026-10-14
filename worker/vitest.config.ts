import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

/**
 * Tests run against real in-memory D1 / R2 / DO / Queue bindings from
 * `wrangler.jsonc` — hermetic, no network.
 *
 * `worker/migrations/*.sql` (source of truth, also applied by wrangler in
 * deploys) is loaded at config time and exposed as the `TEST_MIGRATIONS`
 * binding so `seedSchema()` can apply it to the test D1 database.
 */
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: {
        configPath: './wrangler.jsonc',
      },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations({ migrationsDir: 'migrations' }),
          GITHUB_CLIENT_ID: 'test-client-id',
          GITHUB_CLIENT_SECRET: 'test-client-secret',
        },
      },
    })),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    // commit-graph and blame-chain suites build hundreds of changesets
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
