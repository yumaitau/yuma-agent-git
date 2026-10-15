import { defineConfig } from 'vite';
import type { PluginOption } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Dashboard SPA build (issue #20). `root` is the dashboard directory; Vite
 * resolves `build.outDir` against the root, so `'./dist'` lands in
 * `worker/dashboard/dist` — exactly where `wrangler.jsonc` points its
 * `assets.directory`.
 *
 * Two vite majors live in this monorepo: vite 7 (nested in `worker/`, what
 * `vite build` runs here) and vite 8 (hoisted at the root for vitest 4).
 * `@vitejs/plugin-react` is typed against the root one, so bridge the two.
 */
const reactPlugin = react() as unknown as PluginOption;

export default defineConfig({
  root: './dashboard',
  base: '/',
  plugins: [reactPlugin],
  build: {
    outDir: './dist',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
    // minified size; the enforced budget is gzip (scripts/check-bundle-size.mjs)
    chunkSizeWarningLimit: 600,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8787' },
      '/auth': { target: 'http://localhost:8787' },
    },
  },
});
