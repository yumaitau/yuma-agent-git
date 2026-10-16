# Contributing

`yuma-agent-git` is an npm-workspaces monorepo: `worker/` (the Cloudflare Worker) and
`cli/` (the `yag` thin client).

## Setup

```sh
npm install
```

## Tests

```sh
npm test -w worker
```

Tests are hermetic: they run in miniflare (`@cloudflare/vitest-pool-workers`) with real
in-memory D1 / R2 / Durable Object / Queue bindings from `worker/wrangler.jsonc`. No
network, ever.

Dashboard component tests run in jsdom with `npm run test:ui -w worker`. Each view test
also runs axe-core and fails on serious or critical WCAG 2.2 AA problems
(`worker/dashboard/src/axe.ts`; colour contrast needs a real browser, so it is left out).

`npm run test:e2e` builds the dashboard, starts `wrangler dev --local` on a throwaway
store and drives the golden path (issue, pull request, inline comment, approval, merge)
in Playwright's Chromium (`npx playwright install chromium` once). Set `YAG_E2E_PORT`
when port 18690 is taken. It is not part of `npm test`.

## Local dev

```sh
npm run dev -w worker      # wrangler dev on :8787 (API + built dashboard assets)
npm run dev:ui -w worker   # vite on :5173, proxies /api and /auth to :8787
```

Run both when changing the dashboard: `wrangler dev` serves the API, and `vite`
hot-reloads the SPA. `npm run build -w worker` writes `worker/dashboard/dist`,
which is what the assets binding serves. The gzip budget for that bundle is
250 KiB (`scripts/check-bundle-size.mjs`).

Copy `.dev.vars.example` to `worker/.dev.vars` and fill in GitHub credentials
(and `CACHE_SIGNING_KEY`) when working on auth, the GitHub bridge, or cache tokens.

## Code style

- TypeScript strict everywhere. Zero `any` in committed code.
- `zod` validation at every boundary (HTTP bodies, query params, D1 rows, queue
  messages, R2 payloads).
- Errors use stable `code` strings; HTTP errors use the `{ error: { code, message } }`
  envelope.
- 2-space indent, semicolons, single quotes (`prettier` enforces).
- `npm run lint` and `npm run format` before committing.
