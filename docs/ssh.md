# Git over SSH

Issue #34. People clone and push with registered SSH keys, and repositories
can have read-only or read-write deploy keys, the way GitHub works:

```bash
git clone git@<ssh-host>:owner/repo.git
git push   git@<ssh-host>:owner/repo.git main
```

Where the gateway runs is not decided yet. ADR 0007
(`docs/adr/0007-ssh-gateway.md`) weighs the options and recommends AWS Sydney;
until Justin chooses, nothing is deployed and the host names below are
placeholders.

## How it fits together

```
git ── SSH ──▶ ssh-gateway ── HTTPS ──▶ Worker (internal hostname)
                 │                          │
                 │ 1. is this key known?    │ POST /internal/ssh/authorize {fingerprint}
                 │ 2. token for repo+service│ POST /internal/ssh/authorize {fingerprint, repo, service}
                 │ 3. smart HTTP, token as  │ GET  /owner/repo.git/info/refs?service=…
                 │    the Basic password    │ POST /owner/repo.git/git-upload-pack | git-receive-pack
```

- Workers cannot take inbound TCP, so a small gateway (`ssh-gateway/`, Go,
  `golang.org/x/crypto/ssh`) speaks SSH. It holds no forge data and no user
  credentials; all Git logic stays in the Worker's smart HTTP
  (`docs/git-http.md`).
- During the SSH handshake the gateway asks the Worker whether the offered
  key is registered. Unknown keys are refused, so an SSH client moves on to
  its next key.
- Once the client has proved it holds the key and asked for
  `git-upload-pack` or `git-receive-pack`, the gateway asks for a token. It
  lasts 60 seconds and covers one repository and one service: an upload-pack
  token cannot push and a receive-pack token cannot fetch. The gateway asks
  again before a token runs out, so a long fetch keeps working.
- Every request made with a token re-reads its key. Removing a key, or
  deactivating its owner, stops it at once, including tokens already issued.
- A person's key acts as that person: their role, path rules and org SSO
  apply exactly as they do over HTTPS. A key added from a session that signed
  in through the org's identity provider meets that org's SSO rule; other keys
  do not, as with API tokens.
- A deploy key reaches only its own repository. Read-only deploy keys (the
  default) never get a receive-pack token.
- Fetches need Git protocol v2 (the default since Git 2.26), as over HTTPS.
- Shells, ptys, subsystems such as SFTP, any other command, environment other
  than `GIT_PROTOCOL`, and port forwarding are all refused. There is no
  interactive access of any kind.
- Git LFS over SSH (`git-lfs-authenticate`) is not offered; LFS uses HTTPS.

## Keys

Accepted: `ssh-ed25519`, `ecdsa-sha2-nistp256`, `-nistp384`, `-nistp521`,
`sk-ssh-ed25519@openssh.com` (security keys), and `ssh-rsa` of 3072 bits or
more. DSA keys and RSA keys under 3072 bits are refused. A key can be
registered once only, as either a person's key or one deploy key. Fingerprints
are `SHA256:…`, as `ssh-keygen -lf key.pub` prints them.

SSH keys for signing in are separate from commit signing keys
(`/api/v1/me/signing-keys`, `docs/provenance.md`): adding a key for one
purpose does not grant the other.

| Route                                                         | Who                                   |
| ------------------------------------------------------------- | ------------------------------------- |
| `GET`, `POST /api/v1/me/ssh-keys`, `DELETE …/:id`             | you, from a signed-in session         |
| `GET`, `POST /api/v1/repos/:repo/deploy-keys`, `DELETE …/:id` | repo admins, from a signed-in session |

Adding either kind needs a second factor from the last 12 hours once you have
one. API and agent tokens cannot manage keys. Every add and remove is in the
audit log (`ssh_key.add`, `ssh_key.remove`, `deploy_key.add`,
`deploy_key.remove`), and deploy key changes send a `deploy_key` webhook
event. In the dashboard, keys are under **SSH keys** and deploy keys under
**Settings**.

## The authorise endpoint

`POST /internal/ssh/authorize` is for the gateway only.

- It answers only on the internal hostname in `SSH_GATEWAY_HOST`. On any other
  hostname, or when `SSH_GATEWAY_HOST` or `SSH_GATEWAY_KEY` is unset, it
  answers `404` as if it did not exist.
- It needs the `x-ssh-gateway-key` header to match the `SSH_GATEWAY_KEY`
  secret (compared by SHA-256), else `401`.
- Put the internal hostname behind Cloudflare Access with a service token (or
  mutual TLS) so the edge drops other callers before the Worker runs. The
  gateway sends `CF-Access-Client-Id` and `CF-Access-Client-Secret` when set.

Answers: `200 {"ok": true}` for a key check; `200 {token, expires_at, repo,
service}` for a token; `403 unknown_key`; `404 repo_not_found` for a missing or
unreadable repository (or another repo's deploy key); `403
deploy_key_read_only`; `403 forbidden` with `denied_by`; `403 sso_required`.

The gateway key alone grants nothing a fingerprint does not already name, but
fingerprints are public, so anyone holding the gateway key could get a token
for any registered key. Treat it like a signing key: keep it in the host's
secret store, rotate it, never log it. ADR 0007 records a later fix (the
Worker checking the client's signature itself).

## Running the gateway

```bash
cd ssh-gateway
go test ./...        # includes real git clone and push through the gateway when git and ssh are installed
go build -o ssh-gateway .
```

| Variable                                         | Meaning                                                               |
| ------------------------------------------------ | --------------------------------------------------------------------- |
| `YAG_FORGE_URL`                                  | the Worker's internal hostname, `https://…` (http only for localhost) |
| `YAG_SSH_GATEWAY_KEY`                            | the same value as the Worker's `SSH_GATEWAY_KEY` secret               |
| `YAG_SSH_HOST_KEY_FILE` or `YAG_SSH_HOST_KEY`    | the host private key, as a file or its contents                       |
| `YAG_SSH_LISTEN`                                 | listen address, default `:2222`                                       |
| `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | optional Access service token for the internal hostname               |

On the Worker: `SSH_GATEWAY_HOST` (a var, the internal hostname) and
`SSH_GATEWAY_KEY` (a secret, `wrangler secret put SSH_GATEWAY_KEY`). Generate
the key with `openssl rand -hex 32`.

`ssh-gateway/Dockerfile` builds a static image; nothing builds or deploys it
yet.

### Local development

```bash
# terminal 1: the Worker, with SSH_GATEWAY_HOST=localhost and
# SSH_GATEWAY_KEY=dev-key in worker/.dev.vars
export DOCKER_HOST=unix:///nonexistent.sock
npx wrangler dev --local -c worker/wrangler.jsonc

# terminal 2: the gateway
ssh-keygen -t ed25519 -N '' -f /tmp/yag_host_ed25519
YAG_FORGE_URL=http://localhost:8787 YAG_SSH_GATEWAY_KEY=dev-key \
  YAG_SSH_HOST_KEY_FILE=/tmp/yag_host_ed25519 go run ./ssh-gateway

# terminal 3: register ~/.ssh/id_ed25519.pub under SSH keys, then
GIT_SSH_COMMAND='ssh -p 2222' git clone git@localhost:owner/repo.git
```

## Host keys and publishing their fingerprints

Clients trust the gateway by its host key, so the key must be stable,
private, and published where people can check it.

1. **Generate** one Ed25519 host key per environment, on a trusted machine,
   with no passphrase:
   `ssh-keygen -t ed25519 -N '' -C 'yag-ssh-gateway prod' -f ssh_host_ed25519_key`.
   Every gateway instance in an environment uses the same key, so clients
   see one identity behind a load balancer.
2. **Store** the private key only in the hosting platform's secret store
   (for example AWS Secrets Manager in `ap-southeast-2`, per #68) and give it
   to the gateway as `YAG_SSH_HOST_KEY` or a mounted file. Never commit it,
   bake it into an image, or log it. Delete the local copy once stored.
3. **Record the fingerprint** from the public half:
   `ssh-keygen -lf ssh_host_ed25519_key.pub` (or
   `ssh-gateway -fingerprint` with the same environment as the service).
   The gateway also logs it at start, so you can confirm the running key
   matches.
4. **Publish** it in this file under "Published fingerprints" in a reviewed
   change, and in the dashboard help where people add SSH keys. Optionally
   publish an SSHFP DNS record (`ssh-keygen -r <ssh-host> -f
ssh_host_ed25519_key.pub`) in a DNSSEC-signed zone.
5. **Give people a `known_hosts` line** to pin it ahead of first use:
   `<ssh-host> ssh-ed25519 AAAA…` (the public key file without its comment).
6. **Rotating**: generate the new key, publish its fingerprint next to the
   old one with the date it takes over, wait at least two weeks, then switch
   the gateway and remove the old entry. If a host key leaks, switch at once,
   publish the new fingerprint, and say so in the release notes so people
   expect the `known_hosts` warning.

### Published fingerprints

None yet: the gateway is not deployed (ADR 0007 is Proposed).

## Not done yet

- Hosting: no gateway runs anywhere, and the choice in ADR 0007 is open.
- A Spectrum or Tunnel front end, DDoS limits and connection rate limits.
- Proof of key possession at the Worker (see the ADR's review triggers).
