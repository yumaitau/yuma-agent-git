# Releases

Issue #54. A release is a thin layer over a tag: Markdown notes, assets in R2
and build provenance attestations. Routes are listed in [api.md](api.md).

## Releases and drafts

`POST /api/v1/repos/{owner}/{repo}/releases` takes `{tag, name?, body?,
draft?, prerelease?, generate_notes?, previous_tag?}`. The tag must already
exist (create it with `POST /tags` or `git push`). One release per tag.

- Drafts are visible only to callers who can write the repository. Readers
  get `404` for a draft, its assets and its attestations. Clearing `draft`
  with `PATCH` publishes it and sets `published_at`.
- `latest` is the newest published release that is not a prerelease
  (`GET /releases/latest`).
- Deleting a release deletes its assets from R2. The tag stays.
- Every release route needs whole repository access: assets are build
  outputs of the whole tree, so a caller any path rule restricts gets `403
whole_repository_required`.

## Generated notes

`POST /releases/generate-notes {tag, previous_tag?}` (or `generate_notes:
true` on create) lists the merged pull requests that landed a changeset in
`previous..tag`, then the other non-merge commits, then a full changelog
line. Without `previous_tag` the previous release is the newest published
release on another tag. The notes are a starting point for a person or an
agent to edit.

## Assets and checksums

Upload with `POST /releases/{id}/assets?name=<file>` and the raw bytes as the
body. `Content-Length` is required; the asset must fit the org cap
(`GET`/`PUT /api/v1/orgs/{org}/release-settings`, default 100 MiB, at most
5 GiB; repositories owned by a person use the default). The server computes
the SHA-256 while the bytes stream to R2. Pass `sha256=<hex>` to have the
upload refused (and nothing stored) when the bytes differ.

A download streams the bytes through the same check. When the stored object
no longer matches its SHA-256 the server aborts the response, so a client
never receives altered bytes as a complete download. Responses carry
`x-yag-sha256` and `repr-digest`. `yag release download` checks each file
again before writing it.

## Build provenance

A CI job whose pipeline has `permissions: { id_token: write }` can attest the
assets it built:

```sh
yag release upload v1.2.0 dist/app.tar.gz
yag release attest v1.2.0        # uses YAG_ID_TOKEN_REQUEST_URL and _TOKEN
```

Inside CI, `upload` (and `create` with files) sends the same kind of ID token
in the `X-Yag-Id-Token` header, so each asset records the run that uploaded
it. `attest` requests an ID token with `audience=yag:attest` and posts it to
`POST /releases/{id}/attestations`. The server checks that the token is a
live token from its own issuer for that audience and repository, that the run
exists and that it built the release's target changeset (`409
provenance_source_mismatch` otherwise). A run attests only assets it uploaded
itself: without `assets` it covers those, and naming an asset a person or
another run uploaded is refused (`409 asset_not_from_run`). It then signs an
in-toto v1 statement with an SLSA provenance v1 predicate:

- `subject`: each asset name and SHA-256.
- `buildDefinition`: the workflow ref, event, environment, job and actor from
  the token, and the source as `git+<origin>/<repo>.git@<ref>` with its Git
  commit and changeset ids.
- `runDetails.builder.id`: `<issuer>/builders/cloudflare` for the built-in
  pool, `<issuer>/builders/self-hosted/<runner id>` for self-hosted runners.

The statement is wrapped in a DSSE envelope signed RS256 with the CI OIDC key,
so it verifies against the public `/ci/oidc/jwks`, including keys kept there
after a rotation. `POST /attestations/verify {envelope, sha256?}` checks one
online. `yag release verify <tag>` checks every attestation offline against
the JWKS and exits 1 when an asset has no verified provenance.

The token proves the request came from inside the job; repository code in
that job can make one too, so a release built by an untrusted job is only as
trustworthy as that job. Keep release jobs behind a protected environment.

## Agents and webhooks

Agent tokens need `releases:write`. Creating, editing, deleting or attaching
to a published release is judged as `release.publish` by the agent guardrails
(the default policy pack holds it for a human approval). Drafts are hidden,
so an agent can prepare one (notes, assets, attestations) and a person
publishes it. The `release` webhook event sends `created`, `published`,
`edited` and `deleted`. MCP has `release_list`, `release_get`,
`release_notes`, `release_create` and `release_update` (docs/mcp.md); agents
need `contents:write` with `releases:write` to write.

## Imported releases

A bulk import from GitHub (#72) turns each GitHub release whose tag it
imported into a release here, with its notes (references rewritten), draft
and prerelease flags, author, publish time, and every asset it could download
(each with its SHA-256). Assets whose names this API would refuse, over the
download cap, or that fail to download stay listed in the import report and
`imported_releases` only. A tag that already has a release here keeps it.
Imports send no `release` webhooks.
