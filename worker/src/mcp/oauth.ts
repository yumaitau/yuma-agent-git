import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';
import { C, T } from '../db/schema';
import { q, q1 } from '../db/client';
import { getRepo, getRepoBySlug } from '../db/repos';
import { sha256Hex } from '../core/hashing';
import { ulid } from '../core/ids';
import { errorResponse, readJsonBody } from '../api/errors';
import { recordAudit } from '../audit/record';
import {
  AGENT_KINDS,
  AGENT_SCOPES,
  MAX_TTL_S,
  TOKEN_EXCHANGE_GRANT,
  canDelegate,
  getAgent,
  newAgentToken,
  type Agent,
} from '../auth/agents';
import { can } from '../auth/rbac';
import { currentSession, requireRecentMfa } from '../auth/session';
import { ssoRequirement } from '../auth/sso';
import { createApiToken } from '../auth/tokens';
import type { AppEnv, Principal } from '../auth/principal';

/**
 * OAuth 2.1 authorization server for MCP clients (issue #56, MCP spec
 * 2025-11-25 authorization). `/mcp` is the protected resource; this origin is
 * its authorization server:
 *
 *   - RFC 9728 protected resource metadata and RFC 8414 server metadata;
 *   - RFC 7591 dynamic client registration (public clients, no secrets);
 *   - authorization code with PKCE (S256 only) and RFC 8707 `resource`;
 *   - refresh tokens, rotated on every use.
 *
 * Consent maps onto agent identities (#57): the person picks or creates an
 * agent, the repos (at most 10) and the agent scopes. Approval mints a
 * backing API token (`agent:run`, raw value discarded) that is the delegating
 * subject of every agent token the grant issues, so the usual rules hold:
 * scopes never exceed the agent's grant or the person's role, org SSO is
 * checked through the session's sign-in method, disabling the agent kills its
 * tokens, and revoking the backing token in Settings revokes the grant.
 */

export const mcpOAuthRoutes = new Hono<AppEnv>();

const CODE_TTL_MS = 10 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REFRESH_PREFIX = 'yagrt_';
const MAX_REPOS = 10;
const NO_STORE = { 'cache-control': 'no-store' };

function originOf(c: Context): string {
  return new URL(c.req.url).origin;
}

/** The canonical resource identifier (RFC 8707) of the MCP server. */
export function mcpResource(origin: string): string {
  return `${origin}/mcp`;
}

export function resourceMetadataUrl(origin: string): string {
  return `${origin}/.well-known/oauth-protected-resource/mcp`;
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hash(raw: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(raw));
}

function base64Url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

function protectedResource(c: Context): Response {
  const origin = originOf(c);
  return c.json({
    resource: mcpResource(origin),
    authorization_servers: [origin],
    scopes_supported: AGENT_SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: 'yuma-agent-git',
  });
}

mcpOAuthRoutes.get('/.well-known/oauth-protected-resource', protectedResource);
mcpOAuthRoutes.get('/.well-known/oauth-protected-resource/mcp', protectedResource);

mcpOAuthRoutes.get('/.well-known/oauth-authorization-server', (c) => {
  const origin = originOf(c);
  return c.json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    scopes_supported: AGENT_SCOPES,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token', TOKEN_EXCHANGE_GRANT],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: false,
  });
});

// ---------------------------------------------------------------------------
// Dynamic client registration (RFC 7591)
// ---------------------------------------------------------------------------

export const registerClientSchema = z.object({
  redirect_uris: z.array(z.string().min(1).max(2000)).min(1).max(10),
  client_name: z.string().trim().min(1).max(100).optional(),
  token_endpoint_auth_method: z.string().optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
});

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Redirect URIs must be HTTPS or loopback HTTP, without a fragment. */
function validRedirect(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.hash !== '' || raw.includes('#')) return false;
  return (
    url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname))
  );
}

/** Exact match; loopback redirects may use any port (OAuth 2.1 section 8.4.2). */
function redirectMatches(registered: string[], raw: string): boolean {
  if (registered.includes(raw)) return true;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname)) return false;
  return registered.some((r) => {
    const reg = new URL(r);
    return (
      reg.protocol === 'http:' &&
      reg.hostname === url.hostname &&
      reg.pathname === url.pathname &&
      reg.search === url.search
    );
  });
}

function oauthError(
  c: Context,
  status: 400 | 401,
  error: string,
  description: string,
): Response {
  return c.json({ error, error_description: description }, status, NO_STORE);
}

mcpOAuthRoutes.post('/oauth/register', async (c) => {
  try {
    const parsed = registerClientSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      return oauthError(
        c,
        400,
        'invalid_client_metadata',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    }
    const input = parsed.data;
    const bad = input.redirect_uris.find((uri) => !validRedirect(uri));
    if (bad !== undefined) {
      return oauthError(
        c,
        400,
        'invalid_redirect_uri',
        'redirect URIs must use https, or http on localhost, and have no fragment',
      );
    }
    const now = Date.now();
    const client = {
      client_id: `mcpc_${ulid(now)}`,
      client_name: input.client_name ?? 'MCP client',
      redirect_uris: input.redirect_uris,
    };
    await recordAudit(
      c,
      {
        action: 'mcp.client.register',
        target: client,
      },
      [
        c.env.DB.prepare(
          `INSERT INTO mcp_clients (client_id, client_name, redirect_uris, created_at)
           VALUES (?, ?, ?, ?)`,
        ).bind(
          client.client_id,
          client.client_name,
          JSON.stringify(client.redirect_uris),
          now,
        ),
      ],
    );
    return c.json(
      {
        ...client,
        client_id_issued_at: Math.floor(now / 1000),
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      201,
      NO_STORE,
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

// ---------------------------------------------------------------------------
// Authorization endpoint
// ---------------------------------------------------------------------------

interface McpClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
}

async function getClient(env: Env, id: string): Promise<McpClient | null> {
  const row = await q1<{ client_id: string; client_name: string; redirect_uris: string }>(
    env,
    'SELECT client_id, client_name, redirect_uris FROM mcp_clients WHERE client_id = ?',
    [id],
  );
  if (!row) return null;
  return { ...row, redirect_uris: JSON.parse(row.redirect_uris) as string[] };
}

const authorizeParams = z.object({
  response_type: z.string().optional(),
  client_id: z.string().optional(),
  redirect_uri: z.string().optional(),
  code_challenge: z.string().optional(),
  code_challenge_method: z.string().optional(),
  state: z.string().max(2048).optional(),
  scope: z.string().optional(),
  resource: z.string().optional(),
});
type AuthorizeParams = z.infer<typeof authorizeParams>;

/** The query parameters `GET /oauth/authorize` accepts. */
export const authorizeQuery = authorizeParams;

/** RFC 8707: the `resource` must name this MCP server. */
function isOurResource(origin: string, raw: string): boolean {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname.replace(/\/$/, '')}` === mcpResource(origin);
  } catch {
    return false;
  }
}

type Checked =
  | {
      ok: true;
      client: McpClient;
      redirectUri: string;
      challenge: string;
      scopes: string[];
      state: string | undefined;
    }
  | { ok: false; response: Response };

function redirectWith(
  c: Context,
  redirectUri: string,
  params: Record<string, string | undefined>,
): Response {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries({ ...params, iss: originOf(c) })) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return new Response(null, { status: 302, headers: { location: url.toString() } });
}

/**
 * Validate an authorization request. A bad client or redirect URI shows an
 * error page (never redirect to an unverified URI); anything else goes back
 * to the client as an OAuth error.
 */
async function checkAuthorize(c: Context<AppEnv>, raw: unknown): Promise<Checked> {
  const parsed = authorizeParams.safeParse(raw);
  const p: AuthorizeParams = parsed.success ? parsed.data : {};
  const client = p.client_id ? await getClient(c.env, p.client_id) : null;
  if (!client) {
    return {
      ok: false,
      response: page(
        c,
        400,
        'Unknown client',
        '<p>This app is not registered with this server.</p>',
      ),
    };
  }
  if (!p.redirect_uri || !redirectMatches(client.redirect_uris, p.redirect_uri)) {
    return {
      ok: false,
      response: page(
        c,
        400,
        'Invalid redirect',
        '<p>The redirect URI is not registered for this app.</p>',
      ),
    };
  }
  const back = (error: string, description: string): Checked => ({
    ok: false,
    response: redirectWith(c, p.redirect_uri as string, {
      error,
      error_description: description,
      state: p.state,
    }),
  });
  if (!parsed.success) return back('invalid_request', 'malformed authorization request');
  if (p.response_type !== 'code') {
    return back('unsupported_response_type', 'only response_type=code is supported');
  }
  if (
    p.code_challenge_method !== 'S256' ||
    !/^[A-Za-z0-9_-]{43}$/.test(p.code_challenge ?? '')
  ) {
    return back('invalid_request', 'PKCE with code_challenge_method=S256 is required');
  }
  if (p.resource !== undefined && !isOurResource(originOf(c), p.resource)) {
    return back('invalid_target', `resource must be ${mcpResource(originOf(c))}`);
  }
  const requested = (p.scope ?? '').split(' ').filter((s) => s !== '');
  const unknown = requested.find((s) => !(AGENT_SCOPES as readonly string[]).includes(s));
  if (unknown !== undefined) return back('invalid_scope', `unknown scope ${unknown}`);
  return {
    ok: true,
    client,
    redirectUri: p.redirect_uri,
    challenge: p.code_challenge as string,
    scopes: requested.length > 0 ? requested : [...AGENT_SCOPES],
    state: p.state,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function page(
  c: Context,
  status: 200 | 400 | 403,
  title: string,
  body: string,
): Response {
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:34rem;margin:2rem auto;padding:0 1rem;color:#1b1b1b}
fieldset{border:1px solid #ccc;border-radius:6px;margin:1rem 0}label{display:block;margin:.25rem 0}
input[type=text],select{width:100%;padding:.35rem;box-sizing:border-box}button{padding:.5rem 1rem;margin-right:.5rem}
code{background:#f2f2f2;padding:0 .2rem}</style></head>
<body><h1>${escapeHtml(title)}</h1>${body}</body></html>`,
    status,
    {
      ...NO_STORE,
      'x-frame-options': 'DENY',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    },
  );
}

/** CSRF token for the consent form, bound to the browser session. */
async function consentCsrf(env: Env, cookie: string | undefined): Promise<string | null> {
  const session = await currentSession(env, cookie);
  return session ? hash(`mcp-consent:${session.token_hash}`) : null;
}

/** Agents the user may delegate to: their own, and their orgs'. */
async function delegableAgents(
  env: Env,
  userId: string,
): Promise<{ id: string; name: string; kind: string }[]> {
  return q(
    env,
    `SELECT a.id, a.name, a.kind FROM agents a
      WHERE a.disabled = 0
        AND ((a.owner_kind = 'user' AND a.owner_id = ?)
          OR (a.owner_kind = 'org' AND a.owner_id IN (
               SELECT ${C.orgMembers.orgId} FROM ${T.orgMembers}
                WHERE ${C.orgMembers.userId} = ?
                  AND ${C.orgMembers.role} IN ('owner', 'admin', 'member'))))
      ORDER BY a.created_at DESC`,
    [userId, userId],
  );
}

mcpOAuthRoutes.get('/oauth/authorize', async (c) => {
  try {
    const checked = await checkAuthorize(c, c.req.query());
    if (!checked.ok) return checked.response;
    const user = c.get('user');
    const csrf = user ? await consentCsrf(c.env, c.req.header('cookie')) : null;
    if (!user || csrf === null) {
      return page(
        c,
        200,
        'Sign in to continue',
        `<p><strong>${escapeHtml(checked.client.client_name)}</strong> wants to connect to this forge.</p>
<p><a href="/" target="_blank" rel="noopener">Sign in</a> in a new tab, then reload this page.</p>`,
      );
    }
    const query = c.req.query();
    const hidden = Object.entries(query)
      .filter(([key]) => key in authorizeParams.shape)
      .map(
        ([key, value]) =>
          `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`,
      )
      .join('');
    const agents = await delegableAgents(c.env, user.id);
    const agentOptions = [
      ...agents.map(
        (a) =>
          `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)} (${escapeHtml(a.kind)})</option>`,
      ),
      `<option value="new">New agent: ${escapeHtml(checked.client.client_name)}</option>`,
    ].join('');
    const kindOptions = AGENT_KINDS.filter((k) => k !== 'builtin')
      .map((k) => `<option value="${k}">${k}</option>`)
      .join('');
    const scopeBoxes = AGENT_SCOPES.map(
      (s) =>
        `<label><input type="checkbox" name="scope" value="${s}"${checked.scopes.includes(s) ? ' checked' : ''}> <code>${s}</code></label>`,
    ).join('');
    const redirectHost = new URL(checked.redirectUri).host;
    return page(
      c,
      200,
      'Authorise MCP client',
      `<p><strong>${escapeHtml(checked.client.client_name)}</strong> wants to act as one of your agents.
It will be sent back to <code>${escapeHtml(redirectHost)}</code>. Only approve apps you started yourself.</p>
<form method="post" action="/oauth/authorize">${hidden}
<input type="hidden" name="csrf" value="${csrf}">
<fieldset><legend>Agent</legend><select name="agent">${agentOptions}</select>
<label>Kind for a new agent <select name="kind">${kindOptions}</select></label></fieldset>
<fieldset><legend>Repositories (up to ${MAX_REPOS})</legend>
<input type="text" name="repos" placeholder="owner/name, owner/other" required></fieldset>
<fieldset><legend>Scopes</legend>${scopeBoxes}</fieldset>
<button type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny">Deny</button></form>`,
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

const consentForm = z.object({
  csrf: z.string(),
  decision: z.enum(['approve', 'deny']),
  agent: z.string().min(1),
  kind: z.enum(AGENT_KINDS).optional(),
  repos: z.string().max(2000),
  scope: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => (v === undefined ? [] : [v].flat())),
});

/** The agent the consent names: an existing delegable one, or a new one. */
async function consentAgent(
  c: Context<AppEnv>,
  userId: string,
  choice: string,
  kind: (typeof AGENT_KINDS)[number],
  client: McpClient,
  scopes: string[],
): Promise<Agent | string> {
  if (choice !== 'new') {
    const agent = await getAgent(c.env, choice);
    if (!agent || agent.disabled || !(await canDelegate(c.env, agent, userId))) {
      return 'That agent is not available to you.';
    }
    const over = scopes.find((s) => !agent.max_scopes.includes(s));
    if (over !== undefined) {
      return `Agent ${agent.name} may not hold ${over}. It allows: ${agent.max_scopes.join(', ')}.`;
    }
    return agent;
  }
  const now = Date.now();
  const agent: Agent = {
    id: `agt_${ulid(now)}`,
    owner_kind: 'user',
    owner_id: userId,
    name: client.client_name.slice(0, 80),
    kind,
    max_scopes: scopes,
    allowed_repos: null,
    created_at: now,
    disabled: false,
  };
  await recordAudit(
    c,
    {
      action: 'agent.create',
      target: {
        agent_id: agent.id,
        owner_kind: agent.owner_kind,
        owner_id: agent.owner_id,
        kind: agent.kind,
        max_scopes: agent.max_scopes,
        allowed_repos: null,
        mcp_client_id: client.client_id,
      },
    },
    [
      c.env.DB.prepare(
        `INSERT INTO agents (id, owner_kind, owner_id, name, kind, max_scopes, allowed_repos,
                             created_by, created_at, disabled)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 0)`,
      ).bind(
        agent.id,
        agent.owner_kind,
        agent.owner_id,
        agent.name,
        agent.kind,
        JSON.stringify(agent.max_scopes),
        userId,
        now,
      ),
    ],
  );
  return agent;
}

mcpOAuthRoutes.post('/oauth/authorize', async (c) => {
  try {
    const origin = c.req.header('origin');
    if (origin !== undefined && origin !== originOf(c)) {
      return page(c, 403, 'Forbidden', '<p>Cross-site request refused.</p>');
    }
    const fields = await c.req.parseBody({ all: true });
    const checked = await checkAuthorize(c, {
      ...Object.fromEntries(
        Object.keys(authorizeParams.shape)
          .filter((k) => typeof fields[k] === 'string')
          .map((k) => [k, fields[k]]),
      ),
    });
    if (!checked.ok) return checked.response;
    const user = c.get('user');
    const form = consentForm.safeParse(fields);
    const csrf = user ? await consentCsrf(c.env, c.req.header('cookie')) : null;
    if (!user || csrf === null || !form.success || form.data.csrf !== csrf) {
      return page(c, 403, 'Forbidden', '<p>Sign in and use the consent form.</p>');
    }
    const input = form.data;
    if (input.decision === 'deny') {
      return redirectWith(c, checked.redirectUri, {
        error: 'access_denied',
        error_description: 'the user denied the request',
        state: checked.state,
      });
    }
    const fail = (message: string): Response =>
      page(c, 400, 'Cannot authorise', `<p>${escapeHtml(message)}</p>`);

    const scopes = [...new Set(input.scope)].filter((s) =>
      (AGENT_SCOPES as readonly string[]).includes(s),
    );
    if (scopes.length === 0) return fail('Choose at least one scope.');
    const mfa = await requireRecentMfa(c, {
      strict: c.env.REQUIRE_MFA_FOR_TOKENS === 'true',
    });
    if (mfa)
      return fail('Verify a passkey or authenticator code in the dashboard first.');

    const principal = c.get('principal') as Principal;
    const slugs = [...new Set(input.repos.split(/[\s,]+/).filter((s) => s !== ''))];
    if (slugs.length === 0 || slugs.length > MAX_REPOS) {
      return fail(`Name between 1 and ${MAX_REPOS} repositories.`);
    }
    const agent = await consentAgent(
      c,
      user.id,
      input.agent,
      input.kind ?? 'claude_code',
      checked.client,
      scopes,
    );
    if (typeof agent === 'string') return fail(agent);
    const repos = [];
    for (const slug of slugs) {
      const repo = await getRepoBySlug(c.env, slug);
      if (
        !repo ||
        (agent.allowed_repos !== null && !agent.allowed_repos.includes(repo.id)) ||
        !(await can(c.env, repo, principal, 'read'))
      ) {
        return fail(`Repository ${slug} is not available to this agent.`);
      }
      if (await ssoRequirement(c.env, repo, principal)) {
        return fail(`Sign in through ${slug.split('/')[0]}'s single sign-on first.`);
      }
      repos.push(repo);
    }

    // the delegating subject; its raw value is never shown or kept
    const subject = await createApiToken(c.env, user.id, {
      label: `MCP: ${checked.client.client_name}`.slice(0, 120),
      scopes: [
        'agent:run',
        'repo:read',
        ...(scopes.some((s) => s !== 'contents:read') ? ['repo:write'] : []),
      ],
      authMethod: principal.authMethod ?? null,
    });
    const now = Date.now();
    const grantId = `mcpg_${ulid(now)}`;
    const code = randomHex(32);
    const inserts = [
      c.env.DB.prepare(
        `INSERT INTO mcp_grants (id, client_id, user_id, agent_id, subject_token_id, scopes,
                                 repos, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        grantId,
        checked.client.client_id,
        user.id,
        agent.id,
        subject.id,
        JSON.stringify(scopes),
        JSON.stringify(repos.map((r) => r.id)),
        now,
      ),
      c.env.DB.prepare(
        `INSERT INTO mcp_auth_codes (code_hash, grant_id, redirect_uri, code_challenge, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(
        await hash(code),
        grantId,
        checked.redirectUri,
        checked.challenge,
        now + CODE_TTL_MS,
      ),
    ];
    // one event per repo so each owner's chain shows it; the first carries the inserts
    for (const [i, repo] of repos.entries()) {
      await recordAudit(
        c,
        {
          action: 'mcp.grant.create',
          repo,
          target: {
            grant_id: grantId,
            client_id: checked.client.client_id,
            agent_id: agent.id,
            subject_token_id: subject.id,
            scopes,
            repo_ids: repos.map((r) => r.id),
          },
        },
        i === 0 ? inserts : [],
      );
    }
    return redirectWith(c, checked.redirectUri, { code, state: checked.state });
  } catch (err) {
    return errorResponse(c, err);
  }
});

// ---------------------------------------------------------------------------
// Token endpoint: authorization_code and refresh_token grants
// ---------------------------------------------------------------------------

export const codeGrantSchema = z.object({
  grant_type: z.literal('authorization_code'),
  code: z.string().min(1),
  redirect_uri: z.string().min(1),
  client_id: z.string().min(1),
  code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
  resource: z.string().optional(),
});

export const refreshGrantSchema = z.object({
  grant_type: z.literal('refresh_token'),
  refresh_token: z.string().min(1),
  client_id: z.string().min(1),
  resource: z.string().optional(),
});

const grantRowSchema = z.object({
  id: z.string(),
  client_id: z.string(),
  user_id: z.string(),
  agent_id: z.string(),
  subject_token_id: z.string(),
  scopes: z.string(),
  repos: z.string(),
  refresh_expires_at: z.number().nullable(),
});

/**
 * A grant whose delegation still holds: backing token present and unexpired,
 * agent enabled, person active.
 */
async function liveGrant(
  env: Env,
  where: 'g.id' | 'g.refresh_token_hash',
  value: string,
): Promise<z.infer<typeof grantRowSchema> | null> {
  const row = await q1(
    env,
    `SELECT g.id, g.client_id, g.user_id, g.agent_id, g.subject_token_id, g.scopes, g.repos,
            g.refresh_expires_at
       FROM mcp_grants g
       JOIN agents a ON a.id = g.agent_id
       JOIN ${T.users} u ON u.${C.users.id} = g.user_id
       JOIN ${T.apiTokens} s ON s.${C.apiTokens.id} = g.subject_token_id
      WHERE ${where} = ? AND a.disabled = 0 AND u.active = 1
        AND (s.${C.apiTokens.expiresAt} IS NULL OR s.${C.apiTokens.expiresAt} >= ?)`,
    [value, Date.now()],
  );
  return row ? grantRowSchema.parse(row) : null;
}

async function tokenParams(req: Request): Promise<Record<string, unknown>> {
  try {
    if ((req.headers.get('content-type') ?? '').includes('application/json')) {
      return (await req.json()) as Record<string, unknown>;
    }
    return Object.fromEntries((await req.formData()).entries());
  } catch {
    return {};
  }
}

/** Issue an access token and a rotated refresh token for a grant. */
async function issue(
  c: Context<AppEnv>,
  grant: z.infer<typeof grantRowSchema>,
): Promise<Response> {
  const now = Date.now();
  const scopes = JSON.parse(grant.scopes) as string[];
  const repoIds = JSON.parse(grant.repos) as string[];
  const access = await newAgentToken(
    c.env,
    {
      agentId: grant.agent_id,
      userId: grant.user_id,
      taskId: null,
      scopes,
      repoIds,
      subjectTokenId: grant.subject_token_id,
      ttlS: MAX_TTL_S,
    },
    now,
  );
  const refresh = `${REFRESH_PREFIX}${randomHex(32)}`;
  const statements = [
    access.insert,
    c.env.DB.prepare(
      'UPDATE mcp_grants SET refresh_token_hash = ?, refresh_expires_at = ? WHERE id = ?',
    ).bind(await hash(refresh), now + REFRESH_TTL_MS, grant.id),
  ];
  const repos = (await Promise.all(repoIds.map((id) => getRepo(c.env, id)))).filter(
    (r) => r !== null,
  );
  for (const [i, repo] of [...(repos.length > 0 ? repos : [null])].entries()) {
    await recordAudit(
      c,
      {
        action: 'agent.token.issue',
        repo,
        actor: { kind: 'user', id: grant.user_id },
        target: {
          agent_id: grant.agent_id,
          jti: access.jti,
          scopes,
          repo_ids: repoIds,
          task_id: null,
          expires_at: access.expiresAt,
          mcp_grant_id: grant.id,
        },
      },
      i === 0 ? statements : [],
    );
  }
  return c.json(
    {
      access_token: access.raw,
      token_type: 'Bearer',
      expires_in: MAX_TTL_S,
      refresh_token: refresh,
      scope: scopes.join(' '),
    },
    200,
    NO_STORE,
  );
}

/**
 * Shares `POST /oauth/token` with the RFC 8693 exchange in auth/agents.ts
 * (mounted after this): other grant types fall through to it.
 */
mcpOAuthRoutes.post('/oauth/token', async (c, next) => {
  const params = await tokenParams(c.req.raw.clone());
  if (
    params.grant_type !== 'authorization_code' &&
    params.grant_type !== 'refresh_token'
  ) {
    return next();
  }
  try {
    const origin = originOf(c);
    if (typeof params.resource === 'string' && !isOurResource(origin, params.resource)) {
      return oauthError(
        c,
        400,
        'invalid_target',
        `resource must be ${mcpResource(origin)}`,
      );
    }
    if (params.grant_type === 'authorization_code') {
      const input = codeGrantSchema.safeParse(params);
      if (!input.success) {
        return oauthError(
          c,
          400,
          'invalid_request',
          'invalid authorization_code request',
        );
      }
      const codeHash = await hash(input.data.code);
      const code = await q1<{
        grant_id: string;
        redirect_uri: string;
        code_challenge: string;
        expires_at: number;
      }>(
        c.env,
        'SELECT grant_id, redirect_uri, code_challenge, expires_at FROM mcp_auth_codes WHERE code_hash = ?',
        [codeHash],
      );
      // single use: gone before anything else is checked
      await c.env.DB.prepare('DELETE FROM mcp_auth_codes WHERE code_hash = ?')
        .bind(codeHash)
        .run();
      const grant = code ? await liveGrant(c.env, 'g.id', code.grant_id) : null;
      const challenge = base64Url(
        await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(input.data.code_verifier),
        ),
      );
      if (
        !code ||
        !grant ||
        code.expires_at < Date.now() ||
        grant.client_id !== input.data.client_id ||
        code.redirect_uri !== input.data.redirect_uri ||
        code.code_challenge !== challenge
      ) {
        return oauthError(c, 400, 'invalid_grant', 'invalid, expired or used code');
      }
      return await issue(c, grant);
    }
    const input = refreshGrantSchema.safeParse(params);
    if (!input.success) {
      return oauthError(c, 400, 'invalid_request', 'invalid refresh_token request');
    }
    const grant = await liveGrant(
      c.env,
      'g.refresh_token_hash',
      await hash(input.data.refresh_token),
    );
    if (
      !grant ||
      grant.client_id !== input.data.client_id ||
      (grant.refresh_expires_at ?? 0) < Date.now()
    ) {
      return oauthError(c, 400, 'invalid_grant', 'invalid or expired refresh token');
    }
    return await issue(c, grant);
  } catch (err) {
    return errorResponse(c, err);
  }
});
