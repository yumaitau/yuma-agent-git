# Signed provenance

Issue #58. Every change that lands on a protected branch or tag has a record of
who or what produced it, signed by the forge. Routes are listed in
[api.md](api.md).

## Records

A ref is protected when it is the default branch, or a branch or tag a ruleset
covers. Each move of one (pull request merge, merge queue land, `PUT /refs`,
Git push, agent land) gets one in-toto v1 statement in a DSSE envelope, stored
in the `provenance` table. The predicate type is
`urn:yuma-agent-git:source-provenance:v1`, since SLSA v1.2's source track
fixes no predicate. It holds:

- the ref, the previous and new revision (changeset id and Git commit when
  known) and `via` (`merge`, `merge_queue`, `api`, `git-push`, ...);
- who moved it: the user, or the agent with the person it acted for and its
  task, or the token (with its CI run);
- the pull requests it landed, with their approvals, agent review verdicts
  (#60: reviewer, verdict, confidence, round, findings count) and CI runs;
- the rulesets that applied, what was bypassed, and `bypass`;
- each new changeset (up to 100, with `changesets_total`): its author, agent,
  signature check and the agent sessions linked to it (model, harness, tools,
  transcript SHA-256).

Issuing happens after the move and never fails it. Records are signed with the
first key of `PROVENANCE_SIGNING_KEYS`, an Ed25519 JWK set. All its keys are
published at `/.well-known/yag-provenance-keys`, so a record keeps verifying
after a rotation:

```sh
node scripts/ci-keys.mjs provenance-new --out provenance-keys.json
node scripts/ci-keys.mjs provenance-rotate --current provenance-keys.json --out next.json
```

`GET /api/v1/repos/:repo/provenance?cs=<id>` returns the records that name a
changeset (as the new head or as a changeset the move brought in), each with
the server's own check, plus the commit's signature check and its sessions.
`yag provenance verify <cs>` (or `yag verify <cs>`) checks them offline: the
signature against the published keys, the predicate type and that the
statement covers the changeset. Any edited field fails.

## Commit signatures

Commits pushed over Git are checked as they arrive and the result is kept in
`commit_signatures`:

- SSH (`gpg.format ssh`): an SSHSIG in namespace `git` from a key the person
  registered (Ed25519, RSA with SHA-2, ECDSA P-256).
- OpenPGP: a v4 signature from a registered key or one of its subkeys (RSA,
  Ed25519).
- gitsign (x509): a CMS signature whose certificate chains to a root in
  `SIGSTORE_TRUST_ROOTS` (PEM, the Fulcio root and intermediate) at signing
  time and is for code signing. The signer is the certificate email and its
  OIDC issuer. Rekor inclusion is not checked.

`verified` also needs the committer email to belong to the signer: a linked
email or no-reply address of the key's owner, or the certificate's email.
People manage SSH and OpenPGP keys under Security (`/api/v1/me/signing-keys`,
signed-in sessions only). Changesets the forge wrote itself have no check.

## Rules

- `required_signatures`: every commit pushed over Git that a move brings in
  has a verified signature. Squash and rebase merges write new forge commits,
  so only `merge` merges are checked.
- `required_provenance`: updates come from a reviewed pull request (merge or
  merge queue); a direct move is refused unless the actor may bypass, and the
  record then says `bypass: true`. Every move is refused while the forge has
  no signing key.

## Agent sessions

`POST /api/v1/repos/:repo/sessions` records a session (model, harness, tools,
start and end, a JSON lines transcript) and links changesets. The agent
identity comes from the agent token, never the body. Secrets are redacted with
the secret scanning detectors before the transcript is stored in R2 at
`sessions/<repo id>/<session id>.jsonl`; only repo writers can read it back.
Only the credential that recorded a session links more changesets to it. The
built-in runtime records each task this way when it ends, and agents can use
the MCP `session_record` tool.
