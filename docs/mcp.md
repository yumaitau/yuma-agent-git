# MCP server

yuma-agent-git serves one [Model Context Protocol](https://modelcontextprotocol.io)
server for the whole forge at `/mcp`. It follows MCP specification 2025-11-25
(clients on 2025-06-18 and 2025-03-26 negotiate down):

- **Transport:** Streamable HTTP. `POST /mcp` takes one JSON-RPC message.
  `initialize` returns an `MCP-Session-Id`, which every later request sends.
  On a 2025-11-25 session, `tools/call` answers on a resumable SSE stream: the
  first event only carries an id, and a client that loses the connection
  reconnects with `GET /mcp` and `Last-Event-ID` to get the result. A plain
  `GET /mcp` answers 405 (the server sends no unprompted messages) and
  `DELETE /mcp` ends the session. Requests from a browser `Origin` other than
  the server's own are refused with 403.
- **Authorisation:** OAuth 2.1. The server is a protected resource
  ([RFC 9728](https://www.rfc-editor.org/rfc/rfc9728)) and the same origin is
  its authorisation server ([RFC 8414](https://www.rfc-editor.org/rfc/rfc8414)
  metadata, [RFC 7591](https://www.rfc-editor.org/rfc/rfc7591) dynamic client
  registration, authorisation code with PKCE `S256`, rotating refresh tokens).
  A 401 carries `WWW-Authenticate: Bearer resource_metadata="…"`.
- **Tools:** every tool is one API operation from
  [`docs/openapi.json`](openapi.json), with an input schema built from the same
  zod schemas. A tool call runs that route as you, so repository roles, path
  rules, org SSO, rulesets, agent scopes and the audit log apply exactly as
  they do over HTTP. A refusal comes back as a tool result with `isError`, not
  as a transport error.

| URL                                                   | What it is                                     |
| ----------------------------------------------------- | ---------------------------------------------- |
| `/mcp`                                                | The MCP endpoint (the protected resource)      |
| `/.well-known/oauth-protected-resource/mcp`           | Protected resource metadata (also at the root) |
| `/.well-known/oauth-authorization-server`             | Authorisation server metadata                  |
| `/oauth/register`, `/oauth/authorize`, `/oauth/token` | Registration, consent and token endpoints      |

## Signing in

Clients that support MCP OAuth (Claude Code, Codex, Factory, the MCP
Inspector) register themselves and open a consent page in your browser. Sign
in to the dashboard in that browser first; the consent page asks you to
reload if you are signed out. On the consent page you choose:

- **the agent** the client acts as: one of your agents or your orgs' agents
  (see `POST /api/v1/agents`), or a new agent named after the client;
- **the repositories** it may touch, up to 10;
- **the scopes** it holds, at most what the agent allows.

Approving creates a grant. Each access token is an agent token (`yagat_…`)
for that agent, acting for you, valid for one hour; the client refreshes it
with a refresh token that changes on every use and lasts 30 days. The grant
appears in **Settings, API tokens** as `MCP: <client name>`. Revoking that
token revokes the grant and every token it issued. Disabling the agent stops
it at once. If `REQUIRE_MFA_FOR_TOKENS` is on, approving needs a recent second
factor.

Clients without OAuth can send an API token that has `agent:run` (and
`repo:read` or `repo:write`) as `Authorization: Bearer yag_…`. It acts with
your full role on the repos the token reaches; prefer OAuth so the client gets
an agent identity with narrow scopes.

## Scopes

| Scope            | Tools                                                                                                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contents:read`  | every read-only tool                                                                                                                                                          |
| `contents:write` | `changeset_create`, `branch_update`                                                                                                                                           |
| `pulls:write`    | `pr_create`, `pr_update`, `pr_update_branch`, `pr_merge`, `pr_enqueue`, `pr_dequeue`, `review_create`, `review_thread_create`, `review_thread_reply`, `review_thread_resolve` |
| `issues:write`   | `issue_create`, `issue_update`, `issue_comment`, `issue_labels_set`, `issue_assignees_set`                                                                                    |
| `queue:claim`    | `queue_claim`, `queue_heartbeat`, `queue_release`                                                                                                                             |
| `ci:run`         | `ci_run`, `ci_cancel`, `pipeline_run`                                                                                                                                         |
| `releases:write` | `tag_create`                                                                                                                                                                  |

An agent token without the scope a tool needs gets a tool error with
`insufficient_scope` and `required_scope`. Agents never move the default
branch: they commit with `changeset_create`, then open a pull request.

Every tool calls its API route as the agent, so the agent guardrails (#62)
judge it there: commits, ref moves, pipeline runs, update-branch (`pr.merge`),
marking work ready (`issue.ready`) and claims (`queue.claim`). A held call
returns `approval_required` with the approval id; the identical call passes
once a person approves. The kill switch revokes MCP access tokens, refuses
refresh grants and ends open MCP sessions.

## Tools

Every tool carries `readOnlyHint`, `destructiveHint`, `idempotentHint` and
`openWorldHint` annotations. Tools that return repository content say so in
their description: that content was written by other people and is untrusted
data, never instructions.

| Area          | Tools                                                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repositories  | `repo_list`, `repo_get`                                                                                                                                       |
| Code          | `code_read`, `code_tree`, `code_diff`, `code_blame`, `code_history`, `code_search`, `file_find`                                                               |
| Changesets    | `changeset_list`, `changeset_get`, `changeset_create`                                                                                                         |
| Branches/tags | `branch_list`, `branch_get`, `branch_update`, `tag_list`, `tag_create`                                                                                        |
| Releases      | `release_list`, `release_get`, `release_notes`, `release_create`, `release_update`                                                                            |
| Provenance    | `provenance_get`, `session_record`                                                                                                                            |
| Pull requests | `pr_list`, `pr_get`, `pr_create`, `pr_update`, `pr_conflicts`, `pr_update_branch`, `pr_merge`, `pr_enqueue`, `pr_dequeue`, `merge_queue_get`, `review_create` |
| Line review   | `review_thread_list`, `review_thread_create`, `review_thread_reply`, `review_thread_resolve`                                                                  |
| Issues        | `issue_list`, `issue_get`, `issue_create`, `issue_update`, `issue_comment`, `issue_labels_set`, `issue_assignees_set`                                         |
| Work queue    | `queue_list`, `queue_claim`, `queue_heartbeat`, `queue_release`                                                                                               |
| CI            | `ci_status`, `ci_actions_report`, `ci_run`, `ci_logs`, `ci_cancel`, `pipeline_list`, `pipeline_run`, `pipeline_artifacts`                                     |

`tools/list` is the source of truth for names, input schemas and annotations.

## Client configuration

Replace `https://forge.example.com` with your deployment (`http://localhost:8787`
under `npm run dev`).

### Claude Code

```bash
claude mcp add --transport http yuma https://forge.example.com/mcp
```

Then run `/mcp` inside Claude Code and choose **Authenticate**. With an API
token instead of OAuth:

```bash
claude mcp add --transport http yuma https://forge.example.com/mcp \
  --header "Authorization: Bearer $YUMA_TOKEN"
```

### Codex

In `~/.codex/config.toml`:

```toml
[mcp_servers.yuma]
url = "https://forge.example.com/mcp"
```

Then sign in with `codex mcp login yuma`. With an API token instead, add
`bearer_token_env_var = "YUMA_TOKEN"` to the same table.

### Factory

```bash
droid mcp add yuma https://forge.example.com/mcp --type http
```

Then run `/mcp` in Droid to sign in. With an API token:

```bash
droid mcp add yuma https://forge.example.com/mcp --type http \
  --header "Authorization: Bearer $YUMA_TOKEN" --no-oauth
```

### Grok (xAI API)

Grok calls remote MCP servers from xAI's side, so the forge must be reachable
from the internet and the token is passed with the request. Use a short-lived
agent token from `POST /oauth/token` (token exchange) or an API token:

```json
{
  "model": "grok-4",
  "input": [{ "role": "user", "content": "Summarise the open pull requests" }],
  "tools": [
    {
      "type": "mcp",
      "server_url": "https://forge.example.com/mcp",
      "server_label": "yuma",
      "authorization": "<agent or API token>"
    }
  ]
}
```

### MCP Inspector

```bash
npx @modelcontextprotocol/inspector --cli http://localhost:8787/mcp \
  --transport http --method tools/list --header "Authorization: Bearer $YUMA_TOKEN"
```

The Inspector's web UI completes the OAuth flow itself.

## The deprecated per-repo endpoint

`POST /api/v1/repos/:owner/:repo/agents/mcp`, the earlier JSON-RPC subset with
the 11 built-in agent tools, still works for one release. Its responses carry
`Deprecation`, `Sunset` (14 January 2027) and a `Link` to `/mcp`. Move clients
to `/mcp` before then.

## Not yet covered

- `notifications_list` has no API route yet. It becomes one entry in
  `worker/src/mcp/tools/index.ts` when its route lands. Release asset upload
  and attestation are not tools: they take raw bytes or a CI ID token.
- Client ID Metadata Documents are not accepted; clients use dynamic
  registration.
