# Package registry

The forge hosts container images and Helm charts (OCI distribution spec v1.1)
at `/v2/` and scoped npm packages at `/npm/` (issue #53). Bytes are stored in
R2 under `registry/blobs/sha256/<hex>`, metadata in D1 (`packages`,
`package_versions`, `package_tags`, `package_files`).

## Names and permissions

Every package is linked to one repo when it is first pushed, and uses that
repo's roles from then on:

| Action                          | Needs on the linked repo |
| ------------------------------- | ------------------------ |
| pull, install                   | `read`                   |
| push, publish, move a dist-tag  | `write`                  |
| delete an image tag or manifest | `admin`                  |

- An image name starts with the repo slug: `<host>/<owner>/<repo>[/<more>]`,
  for example `forge.example.com/acme/app/web`. Names are lower case, as the
  OCI spec requires.
- An npm package is `@<owner>/<name>`. It links to the repo `<owner>/<name>`;
  when there is no such repo, to the repo on this forge that package.json
  `repository` names (it must belong to the same owner). Unscoped packages
  are refused.
- Token limits apply on top of the role: API tokens pull with `repo:read` and
  push with `repo:write`; agent tokens pull with `contents:read` and push with
  `packages:write`, never past the delegating person's role. Agent publishes
  are judged by the guardrails as `release.publish`, so the default policy
  holds them for a human approval (the approval binds the exact digest or
  version).
- A caller any path rule restricts cannot use the repo's packages at all,
  like Git: an image or tarball is built from the whole tree.
- A repo the caller cannot read answers 404 (`NAME_UNKNOWN`, or npm
  `not_found`), the same as one that does not exist. Without credentials the
  answer is 401 with `WWW-Authenticate`.
- Only the `Authorization` header counts. Browser sessions are ignored, so a
  page on another site cannot push.

### CI jobs

A pipeline job that sets `permissions: { packages: write }` gets a registry
login in `$YAG_REGISTRY`, `$YAG_REGISTRY_USERNAME` and `$YAG_REGISTRY_PASSWORD`
(the job's request token, masked in logs). It needs no OIDC setup:

```yaml
jobs:
  chart:
    permissions: { packages: write }
    steps:
      - run: |
          echo "$YAG_REGISTRY_PASSWORD" | helm registry login "$YAG_REGISTRY" \
            -u "$YAG_REGISTRY_USERNAME" --password-stdin
          helm package ./chart
          helm push web-0.1.0.tgz "oci://$YAG_REGISTRY/acme/app/charts"
```

A job with `permissions.id_token: write` (see docs/ci-oidc-aws.md) can also use
`$YAG_ID_TOKEN_REQUEST_TOKEN`, or an ID token minted with the registry host as
audience:
`curl -H "Authorization: Bearer $YAG_ID_TOKEN_REQUEST_TOKEN" "$YAG_ID_TOKEN_REQUEST_URL&audience=forge.example.com"`.

Each pulls the packages linked to the job's own repo and nothing else, and
pushes them only when the job also has `permissions.packages: write` (403
otherwise): a job of repo A gets 404 for a package of repo B. It stops working when
the run ends. Fork pull requests and other untrusted runs get no login. A
self-hosted runner's clone token pulls only. A publish from a job an agent
started is judged by the agent policy as that agent's (#62).

## Docker

```bash
echo "$YAG_TOKEN" | docker login forge.example.com -u any --password-stdin
docker buildx build --platform linux/amd64,linux/arm64 \
  -t forge.example.com/acme/app/web:1.0.0 --push .
docker pull forge.example.com/acme/app/web:1.0.0
```

Docker gets a 401 with
`Bearer realm="https://forge.example.com/v2/token",service="forge.example.com"`,
exchanges the login for a registry token (valid five minutes, limited to the
actions the caller holds now) and retries. In a pipeline:

```bash
echo "$YAG_REGISTRY_PASSWORD" | docker login "$YAG_REGISTRY" -u ci --password-stdin
```

## Helm

Helm 3.8 and later (and Helm 4) push charts as OCI artefacts:

```bash
helm registry login forge.example.com -u any --password "$YAG_TOKEN"
helm package ./chart                     # web-0.1.0.tgz
helm push web-0.1.0.tgz oci://forge.example.com/acme/app/charts
helm pull oci://forge.example.com/acme/app/charts/web --version 0.1.0
helm install web oci://forge.example.com/acme/app/charts/web --version 0.1.0
```

The chart lands at `acme/app/charts/web` with the chart version as its tag.
For `wrangler dev` on plain HTTP add `--plain-http` to `push`, `pull` and
`registry login`.

## Signatures and SBOMs (cosign)

Manifests that carry a `subject` are served by the referrers API
(`GET /v2/<name>/referrers/<digest>`, with `artifactType` filtering), and the
push answers with `OCI-Subject`, so cosign uses it:

```bash
cosign sign --registry-referrers-mode=oci-1-1 forge.example.com/acme/app/web@sha256:…
cosign verify --experimental-oci11 --key cosign.pub forge.example.com/acme/app/web@sha256:…
```

cosign's older tag scheme (`sha256-<hex>.sig`) also works, since tags are free
form. Retention never deletes a signature while its subject is still there.

## npm

`.npmrc`:

```ini
@acme:registry=https://forge.example.com/npm/
//forge.example.com/npm/:_authToken=${YAG_TOKEN}
```

```bash
npm publish                          # @acme/app from the repo acme/app
npm install @acme/app
npm dist-tag add @acme/app@2.0.0 next
npm whoami --registry https://forge.example.com/npm/
```

npm sends the tarball inside the publish document, so a publish is read whole
and capped at 64 MiB. A version cannot be published twice (409), and the
tarball must match `dist.integrity`. Unpublish and deprecate are not served.
Errors are npm's `{ "error": "<message>" }` with a stable `code` next to it.

## Storage, quotas and retention

- Blob uploads stream to R2. A chunked upload (`POST`, `PATCH` …, `PUT
?digest=`) goes into an R2 multipart upload in 8 MiB parts; only the bytes
  below one part are held in memory, and they wait in
  `registry/uploads/<id>/tail` between requests. Finishing streams the upload
  once more into its blob key, and R2 checks the SHA-256 as it stores it, so
  a blob is never kept under a digest it does not have. A monolithic upload
  with `Content-Length` streams straight into its blob key.
- A package can serve a blob only after a verified upload to it, or a mount
  (`?mount=<digest>&from=<name>`) from a package the caller can pull.
  Knowing a digest is not enough.
- Each owner (the first part of the slug) has a storage quota,
  `REGISTRY_QUOTA_BYTES` (default 10 GiB). Uploads past it get 413 with
  `reason: quota_exceeded`.
- `PATCH /api/v1/repos/:owner/:repo/packages/:id` with
  `{ "keep_untagged": N }` (repo admins) keeps the newest N untagged manifests
  of an image. The minute cron deletes older ones, except children of an index
  that is kept and referrers whose subject is kept, drops blob links no
  manifest uses after a day, and deletes R2 blobs no package links. It also
  drops uploads idle for a day and expired registry tokens.
  `GET /api/v1/repos/:owner/:repo/packages` lists a repo's packages.

## Audit and webhooks

Manifest pushes and npm publishes are audited as `package.publish`, deletes as
`package.delete`, dist-tag changes as `package.tag` and retention changes as
`package.settings.update`. Blob uploads are not: a blob is unreachable until a
published manifest names it. Webhooks get a `package` event (`published`,
`tagged`, `deleted`) in the `yag` format.

## Not yet

- The CI publisher VM (`worker/src/ci/runner.ts`) still pushes to the
  external registry configured by `CI_REGISTRY_*`; pipelines can push here
  with `docker login` and their request token.
- `docker push`, `helm` against a deployment and `cosign sign`/`verify` are
  covered by protocol tests and a local `helm` and `npm` smoke against
  `wrangler dev` (cli/test/registry.test.ts), not yet against a live
  deployment.
