# ADR 0007: Where the Git over SSH gateway runs

- Status: Proposed (the hosting choice is Justin's)
- Date: 2026-10-16
- Issue: #34 (epic #29, roadmap #23)

## Context

Issue #34 asks for `git clone git@<host>:owner/repo.git` and `git push` with
registered SSH keys and per-repo deploy keys. The issue names this record
`0002-ssh-gateway.md`; 0002 is the SAML record, so it is 0007.

Facts the choice rests on:

- Workers cannot accept inbound TCP, so SSH needs a separate front end. Git
  logic stays in one place: the gateway authenticates the key, asks the
  Worker for a token that lasts 60 seconds and covers one repository and one
  service, then speaks smart HTTP (`worker/src/git/http.ts`) with it. The
  gateway holds no forge data and no long-lived user credential.
- Cloudflare Containers are started and reached through a Worker and a
  Durable Object (`container.fetch()`). The Containers docs describe no
  public IP and no inbound TCP from end users
  ([FAQ](https://developers.cloudflare.com/containers/faq/),
  [limits](https://developers.cloudflare.com/containers/platform/limits/)).
- Spectrum proxies TCP. SSH is one of the protocols on Pro and Business (paid
  add-on, one SSH app per zone); any other TCP port needs Enterprise
  ([protocols per plan](https://developers.cloudflare.com/spectrum/protocols-per-plan/)).
  Its origin is an IP or a DNS name, or a single private IP reached through a
  Cloudflare Tunnel or WAN connector
  ([configuration](https://developers.cloudflare.com/spectrum/reference/configuration-options/)).
  Spectrum works at layer 4: SSH stays encrypted from the client to the
  gateway, so Cloudflare does not see Git data on that hop.
- Cloudflare Tunnel on its own reaches a public SSH client only when the
  client runs `cloudflared access ssh` as its `ProxyCommand`. That breaks the
  stock `git clone git@host:…` that the issue asks for, unless Spectrum sits
  in front of the Tunnel.
- Residency (#68): wherever the gateway runs is where pushed and fetched
  source is decrypted. The gateway then calls the Worker over HTTPS, which
  carries the same residency position as the rest of the forge (Regional
  Services set to Australia limits where that hop is decrypted).

## Options

**A. Gateway in a Cloudflare Container behind Spectrum.** One platform, one
bill. But Spectrum cannot point at a container: containers have no public
address. The only route we can see is a container that runs `cloudflared`
and dials out to a Tunnel, with Spectrum's origin set to that Tunnel's
private IP. That is not documented as a supported pattern, needs the
container kept awake (Containers bill for active instance time), and gives
no control over which Cloudflare location runs it, so SSH would be decrypted
wherever the container lands. It needs a spike before it can be chosen.

**B. Gateway on Yuma's own infrastructure in Sydney.** A small stateless
container (`ssh-gateway/`) on AWS `ap-southeast-2`, for example two Fargate
tasks behind a Network Load Balancer, or one small EC2 instance. Clients
reach it directly, or through a Spectrum SSH app pointed at the load
balancer for DDoS cover. SSH is decrypted only in Sydney. The homelab is the
same option on a cheaper host, but a residential uplink and a single machine
are not a service customers can depend on; it suits a preview only.

**C. Cloudflare Tunnel only.** `cloudflared` beside the gateway (on any
host, including the homelab) with no inbound port open. Every developer and
runner then needs `cloudflared` installed and an SSH `ProxyCommand`, which
GitHub users and Factory containers do not have today. Tunnel is a good way
to connect the gateway to Spectrum (option B without an open port), not a
front end on its own.

## Scoring

Nothing here was measured. Prices are not quoted because none were checked
against current price lists; each cell names what drives the cost.

| Criterion                    | A. Container + Spectrum                   | B. Own infra, Sydney (optional Spectrum)       | C. Tunnel only                            |
| ---------------------------- | ----------------------------------------- | ---------------------------------------------- | ----------------------------------------- |
| Stock `git clone git@host:…` | Only if the unverified route works        | Yes                                            | No (client needs `cloudflared`)           |
| Where SSH is decrypted (#68) | Any Cloudflare location, no control       | Sydney only                                    | Wherever the gateway host is              |
| Cost drivers                 | Spectrum add-on, always-on container      | NLB hours and traffic, small compute, Spectrum | Host only; Tunnel has no separate fee     |
| Operations                   | Cloudflare only, but an undocumented path | Second cloud: patching, alarms, IAM, deploys   | `cloudflared` upkeep on hosts and clients |
| Documented and supported     | No                                        | Yes                                            | Yes                                       |
| DDoS cover on port 22        | Spectrum                                  | Spectrum if fronted, else AWS Shield Standard  | Tunnel (no open port)                     |

## Recommendation

Option B: run `ssh-gateway/` as a container in AWS Sydney behind a Network
Load Balancer, and decide separately whether to put a Spectrum SSH app in
front of it. It is the only option that gives stock Git over SSH with the
decryption point fixed in Australia, and it uses only documented features.
The cost is a second platform to run. Justin makes the final call; until
then this record stays Proposed and nothing is deployed.

## Consequences

Whichever host is chosen, these hold and are built in this change:

- The authorise endpoint `POST /internal/ssh/authorize` answers only on a
  separate internal hostname (`SSH_GATEWAY_HOST`) and only with the gateway
  key (`SSH_GATEWAY_KEY`, compared by hash). On the public hostname it
  answers 404 as if it did not exist. The internal hostname should also sit
  behind Cloudflare Access with a service token or mutual TLS, so the edge
  drops other callers before the Worker runs; the gateway sends the Access
  service token headers when configured.
- The gateway key is the one secret the gateway holds. It does not give
  access on its own: it turns a key fingerprint into a 60-second token, and
  fingerprints are public. Anyone holding the key could ask for a token for
  any registered key, so it must be treated like a signing key: kept in the
  host's secret store, rotated, and never logged. A later change could close
  this by sending the client's signature over the SSH session id for the
  Worker to check, so a stolen gateway key alone grants nothing.
- Host keys live with the gateway (file or environment), and their
  fingerprints are published in `docs/ssh.md`.
- A second platform (option B) needs its own deploy, patching, logging and
  alarms, and its logs must stay in Australia under #68.

## Review triggers

- Cloudflare documents inbound TCP to Containers or Spectrum origins on
  Containers, with location control in Australia.
- #68 settles residency in a way that accepts decryption outside Australia.
- The AWS running cost or operating load turns out higher than the value of
  SSH to customers, measured once deployed.
- A security review asks for proof of key possession at the Worker.
