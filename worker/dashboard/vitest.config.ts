import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import type { PluginOption } from 'vite';

/**
 * Component-test runner for the dashboard SPA (jsdom + @testing-library/react).
 *
 * Kept separate from `worker/vitest.config.ts` on purpose: the worker suite is
 * a miniflare/cloudflare:test environment (`npm test -w worker`), while these
 * tests are browser-DOM unit tests. Run them with:
 *
 *   npx vitest run --config dashboard/vitest.config.ts   (from worker/)
 *   npx vitest run --config worker/dashboard/vitest.config.ts   (from repo root)
 */
const root = fileURLToPath(new URL('.', import.meta.url));
const reactPlugin = react() as unknown as PluginOption;

export default defineConfig({
  root,
  plugins: [reactPlugin],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
    setupFiles: ['./src/test-setup.ts'],
    clearMocks: true,
    // theme.test.ts reads the stylesheet source through `?raw`.
    css: { include: [/theme\.css/] },
  },
});
