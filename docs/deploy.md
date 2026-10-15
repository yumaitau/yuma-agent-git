# Deploying yuma-agent-git

One-command deploy once the Cloudflare resources and GitHub App exist.

## 1. Cloudflare resources

```sh
# D1 metadata database
npx wrangler d1 create yag-db -c worker/wrangler.jsonc          # paste the id into worker/wrangler.jsonc
npx wrangler d1 migrations apply yag-db --remote --env prod -c worker/wrangler.jsonc

# R2 content-addressed object store
npx wrangler r2 bucket create yag-objects -c worker/wrangler.jsonc

# Queues (idempotent)
./scripts/setup-queues.sh
```

`database_id` in `worker/wrangler.jsonc` is environment-specific — replace the
placeholder in both the base and `env.prod` database bindings. Do **not** commit secrets: CI greps `wrangler.jsonc` for
`gh[ps]_` / `-----BEGIN` material and fails.

## 2. Secrets (never in VCS)

```sh
npx wrangler secret put GITHUB_CLIENT_ID --env prod -c worker/wrangler.jsonc
npx wrangler secret put GITHUB_CLIENT_SECRET --env prod -c worker/wrangler.jsonc
npx wrangler secret put GITHUB_APP_ID --env prod -c worker/wrangler.jsonc
npx wrangler secret put GITHUB_APP_PRIVATE_KEY --env prod -c worker/wrangler.jsonc   # PKCS#8 PEM
npx wrangler secret put GITHUB_WEBHOOK_SECRET --env prod -c worker/wrangler.jsonc
npx wrangler secret put CACHE_SIGNING_KEY --env prod -c worker/wrangler.jsonc        # cache-token HMAC key
```

Local development uses `worker/.dev.vars` (copy `.dev.vars.example`).

## 3. GitHub App

Create an app at https://github.com/settings/apps with:

- Callback URL: `https://<your-worker>.workers.dev/auth/github/callback`
- Setup URL / install callback: `https://<your-worker>.workers.dev/auth/github/install-callback`
- Webhook URL: `https://<your-worker>.workers.dev/webhooks/github`
- Webhook secret: the same value as `GITHUB_WEBHOOK_SECRET`
- Permissions: Contents **read**, Metadata **read**
- Subscribe to: `installation`, `installation_repositories`, `push`
- Where can it be installed: any account (org installation supported)

## 4. Deploy

```sh
npm run deploy
```

This runs, in order:

1. `vite build` — dashboard SPA into `worker/dashboard/dist` (the assets binding)
2. `./scripts/setup-queues.sh` — provision `derived-data`, `agent-jobs`, `git-import`
3. `wrangler d1 migrations apply yag-db --remote --env prod`
4. `wrangler deploy --env prod` — deploy the Worker with its production D1, R2,
   Durable Object, Queue, and Workers AI bindings. AI stays out of the base
   config so local tests do not require remote credentials.

The URL lands in the deploy output (`https://yuma-agent-git-prod.<account>.workers.dev`);
add a custom domain with `worker/wrangler.jsonc` `routes` in `env.prod` or the
dashboard, as preferred.

## 5. Verify

```sh
curl https://<your-worker>.workers.dev/healthz          # {"ok":true}
curl https://<your-worker>.workers.dev/api/v1/repos     # public + yours
```

`wrangler deploy --dry-run` must pass in CI with zero plaintext secrets — the
workflow greps for key material and fails on any hit.
