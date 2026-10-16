import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';
import { hasScope, type AppEnv, type Principal } from '../auth/principal';
import { can, type RepoWithCreator } from '../auth/rbac';
import { loadWholeRepo, requireAgentScope } from '../auth/guards';
import { errorResponse, readJsonBody } from './errors';
import { loadOrg } from './orgs';
import { q, q1, run } from '../db/client';
import { getRef } from '../db/repos';
import { TAG_PREFIX } from '../core/refs';
import { ApiError } from '../core/errors';
import { IncrementalSha256 } from '../core/hashing';
import { ulid } from '../core/ids';
import { actorOf, recordAudit } from '../audit/record';
import { emitEvent } from '../webhooks/events';
import { agentKey, enforceAgentAction } from '../policy/guardrails';
import { pauseFor, pauseMessage } from '../policy/pause';
import { issuerFor } from '../ci/oidc';
import {
  envelopeSchema,
  signEnvelope,
  verifyEnvelope,
  verifyForgeJwt,
} from '../provenance/dsse';
import { b64urlDecode } from '../auth/encoding';
import { generateNotes } from '../releases/notes';
import { buildProvenance, ATTEST_AUDIENCE } from '../releases/provenance';
import type {
  Release,
  ReleaseAsset,
  ReleaseAttestationSummary,
} from '../../shared/releases';

/**
 * Releases (issue #54): a release names an existing tag and carries Markdown
 * notes, assets in R2 and build provenance.
 *
 *   GET    /repos/:repo/releases                    list (drafts need write)
 *   POST   /repos/:repo/releases                    create from a tag
 *   GET    /repos/:repo/releases/latest             newest published, not prerelease
 *   GET    /repos/:repo/releases/tags/:tag          by tag
 *   POST   /repos/:repo/releases/generate-notes     notes from previous..tag
 *   GET|PATCH|DELETE /repos/:repo/releases/:id
 *   POST   /repos/:repo/releases/:id/assets?name=   raw upload, SHA-256 on the way in
 *   GET|DELETE /repos/:repo/releases/:id/assets/:asset   download is checked on the way out
 *   GET|POST /repos/:repo/releases/:id/attestations SLSA provenance from a CI ID token
 *   POST   /repos/:repo/attestations/verify         check a DSSE envelope
 *   GET|PUT /orgs/:org/release-settings             per-org asset size cap
 *
 * Assets are build outputs of the whole tree, so every route needs whole
 * repository access. Writes also need `releases:write` for agent tokens and
 * are judged as `release.publish` by the agent guardrails (#62).
 *
 * A CI job uploads with its ID token (audience `yag:attest`) in the
 * `X-Yag-Id-Token` header, which records the run on the asset. A run attests
 * only assets its own jobs uploaded (#58), so a person cannot slip bytes
 * into a release and have a build vouch for them.
 */
export const releasesRoutes = new Hono<AppEnv>();

const REPO = '/repos/:repo{[^/]+/[^/]+}';
const NO_STORE = 'private, no-store';
export const DEFAULT_ASSET_MAX_BYTES = 100 * 1024 * 1024;
const MAX_ASSET_SETTING = 5 * 1024 * 1024 * 1024;
const MAX_ASSETS = 100;
export const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,254}$/;
export const CONTENT_TYPE = /^[\w.+-]+\/[\w.+-]+$/;

for (const path of [`${REPO}/releases`, `${REPO}/releases/*`]) {
  releasesRoutes.use(path, async (c, next) => {
    await next();
    c.header('cache-control', NO_STORE);
  });
}

// ---------------------------------------------------------------------------
// Schemas (contract.ts documents these)
// ---------------------------------------------------------------------------

const tagName = z.string().min(1).max(245);
export const createReleaseSchema = z.object({
  tag: tagName,
  name: z.string().max(200).optional(),
  body: z.string().max(125_000).optional(),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
  /** Append notes generated from `previous_tag..tag` to `body`. */
  generate_notes: z.boolean().optional(),
  previous_tag: tagName.optional(),
});
export const updateReleaseSchema = z.object({
  name: z.string().max(200).optional(),
  body: z.string().max(125_000).optional(),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
});
export const generateNotesSchema = z.object({
  tag: tagName,
  previous_tag: tagName.optional(),
});
export const listReleasesQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export const uploadAssetQuery = z.object({
  name: z.string().regex(ASSET_NAME, 'letters, digits, ., _, + or -'),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional()
    .describe('Expected digest; the upload is refused if the bytes differ'),
});
export const attestSchema = z.object({
  /** A CI ID token (`/ci/oidc/token?audience=yag:attest`) from the build's job. */
  id_token: z.string().min(1).max(16_384),
  /** Asset names to cover; default every asset of the release. */
  assets: z.array(z.string().regex(ASSET_NAME)).min(1).max(MAX_ASSETS).optional(),
});
export const verifyAttestationSchema = z.object({
  envelope: envelopeSchema,
  /** Require a subject with this digest. */
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});
export const releaseSettingsSchema = z.object({
  asset_max_bytes: z.number().int().min(1).max(MAX_ASSET_SETTING),
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ApiError(
      400,
      'invalid_request',
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Rows and views
// ---------------------------------------------------------------------------

const releaseRowSchema = z.object({
  id: z.string(),
  repo_id: z.string(),
  tag: z.string(),
  target_cs: z.string(),
  name: z.string(),
  body: z.string(),
  draft: z.number(),
  prerelease: z.number(),
  created_by: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
  published_at: z.number().nullable(),
});
type ReleaseRow = z.infer<typeof releaseRowSchema>;

const assetRowSchema = z.object({
  id: z.string(),
  release_id: z.string(),
  name: z.string(),
  content_type: z.string(),
  size: z.number(),
  sha256: z.string(),
  uploaded_by: z.string(),
  run_id: z.string().nullable(),
  created_at: z.number(),
});
type AssetRow = z.infer<typeof assetRowSchema>;

const attestationRowSchema = z.object({
  id: z.string(),
  release_id: z.string(),
  run_id: z.string(),
  key_id: z.string(),
  envelope: z.string(),
  created_by: z.string(),
  created_at: z.number(),
});

function principalOf(c: Context<AppEnv>): Principal {
  return c.get('principal') as Principal; // `/api/*` refused anonymous callers
}

function actorKey(principal: Principal): string {
  const actor = actorOf(principal);
  return `${actor.kind}:${actor.id}`;
}

/** Drafts are for people (and tokens) who may write the repo. */
async function canWrite(c: Context<AppEnv>, repo: RepoWithCreator): Promise<boolean> {
  const principal = principalOf(c);
  return hasScope(principal, 'repo:write') && can(c.env, repo, principal, 'write');
}

async function latestId(env: Env, repoId: string): Promise<string | null> {
  const row = await q1<{ id: string }>(
    env,
    `SELECT id FROM releases WHERE repo_id = ? AND draft = 0 AND prerelease = 0
      ORDER BY published_at DESC, id DESC LIMIT 1`,
    [repoId],
  );
  return row?.id ?? null;
}

function assetView(row: AssetRow): ReleaseAsset {
  return {
    id: row.id,
    name: row.name,
    content_type: row.content_type,
    size: row.size,
    sha256: row.sha256,
    uploaded_by: row.uploaded_by,
    run_id: row.run_id,
    created_at: row.created_at,
  };
}

interface CiJob {
  id: string;
  head_cs: string;
  runner_id: string | null;
  started_at: number | null;
}

/** The run of this repo a CI ID token (audience `yag:attest`) was minted for. */
async function ciJob(
  c: Context<AppEnv>,
  repo: RepoWithCreator,
  idToken: string,
): Promise<{ claims: Record<string, unknown>; job: CiJob }> {
  const claims = await verifyForgeJwt(c.env, idToken, {
    issuer: issuerFor(c.env, new URL(c.req.url).origin),
    audience: ATTEST_AUDIENCE,
  });
  if (!claims)
    throw new ApiError(
      400,
      'invalid_id_token',
      `The ID token is not a live CI token from this forge with audience ${ATTEST_AUDIENCE}`,
    );
  if (claims.repository_id !== repo.id)
    throw new ApiError(
      400,
      'id_token_repo_mismatch',
      'The ID token is for another repository',
    );
  const job = await q1<CiJob>(
    c.env,
    'SELECT id, head_cs, runner_id, started_at FROM ci_runs WHERE id = ? AND repo_id = ?',
    [String(claims.run_id), repo.id],
  );
  if (!job)
    throw new ApiError(400, 'unknown_run', 'The ID token names no run of this repo');
  return { claims, job };
}

const storedEnvelope = z.object({
  payload: z.string(),
});
const statementSubjects = z.object({
  subject: z.array(
    z.object({ name: z.string(), digest: z.object({ sha256: z.string() }) }),
  ),
});

/** Subjects of a stored envelope (we wrote it, so it parses). */
function subjectsOf(envelope: string): ReleaseAttestationSummary['subjects'] {
  const { payload } = storedEnvelope.parse(JSON.parse(envelope));
  const json = new TextDecoder().decode(b64urlDecode(payload));
  return statementSubjects.parse(JSON.parse(json)).subject;
}

async function views(env: Env, rows: ReleaseRow[]): Promise<Release[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => '?').join(',');
  const assets = (
    await q(
      env,
      `SELECT * FROM release_assets WHERE release_id IN (${marks}) ORDER BY name`,
      ids,
    )
  ).map((r) => assetRowSchema.parse(r));
  const attestations = (
    await q(
      env,
      `SELECT id, release_id, run_id, key_id, envelope, created_by, created_at
         FROM release_attestations WHERE release_id IN (${marks}) ORDER BY id`,
      ids,
    )
  ).map((r) => attestationRowSchema.parse(r));
  const latest = await latestId(env, rows[0]!.repo_id);
  return rows.map((row) => ({
    id: row.id,
    tag: row.tag,
    target_cs: row.target_cs,
    name: row.name,
    body: row.body,
    draft: row.draft === 1,
    prerelease: row.prerelease === 1,
    latest: row.id === latest,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    published_at: row.published_at,
    assets: assets.filter((a) => a.release_id === row.id).map(assetView),
    attestations: attestations
      .filter((a) => a.release_id === row.id)
      .map((a) => ({
        id: a.id,
        run_id: a.run_id,
        key_id: a.key_id,
        subjects: subjectsOf(a.envelope),
        created_by: a.created_by,
        created_at: a.created_at,
      })),
  }));
}

async function view(env: Env, row: ReleaseRow): Promise<Release> {
  return (await views(env, [row]))[0]!;
}

/** The release, or 404; drafts are 404 to callers who cannot write. */
async function loadRelease(
  c: Context<AppEnv>,
  repo: RepoWithCreator,
  where: { id: string } | { tag: string },
): Promise<ReleaseRow> {
  const row = await q1(
    c.env,
    'id' in where
      ? 'SELECT * FROM releases WHERE repo_id = ? AND id = ?'
      : 'SELECT * FROM releases WHERE repo_id = ? AND tag = ?',
    [repo.id, 'id' in where ? where.id : where.tag],
  );
  const release = row ? releaseRowSchema.parse(row) : null;
  if (!release || (release.draft === 1 && !(await canWrite(c, repo))))
    throw new ApiError(404, 'release_not_found', 'No such release');
  return release;
}

async function getRow(env: Env, id: string): Promise<ReleaseRow> {
  return releaseRowSchema.parse(
    await q1(env, 'SELECT * FROM releases WHERE id = ?', [id]),
  );
}

/** The `release` webhook event (#75). */
async function emitRelease(
  c: Context<AppEnv>,
  repo: RepoWithCreator,
  action: 'created' | 'published' | 'edited' | 'deleted',
  release: Release,
): Promise<void> {
  await emitEvent(c.env, repo, {
    event: 'release',
    action,
    actor: actorOf(principalOf(c)),
    origin: new URL(c.req.url).origin,
    data: { release },
  });
}

/**
 * Agent guardrails (#62). A change readers can see (publishing, or touching a
 * published release) is a `release.publish`; drafts are hidden, so an agent
 * may prepare one under the kill switch alone and a person publishes it.
 */
async function judge(
  c: Context<AppEnv>,
  repo: RepoWithCreator,
  tag: string,
  visible: boolean,
  exact: Record<string, unknown>,
): Promise<void> {
  const principal = principalOf(c);
  if (!visible) {
    if (agentKey(principal) === null) return;
    const pause = await pauseFor(c.env, repo);
    if (pause)
      throw new ApiError(403, 'agents_paused', pauseMessage(pause), {
        paused_by: pause.paused_by_login ?? pause.paused_by,
      });
    return;
  }
  const { body: _body, ...summary } = exact;
  await enforceAgentAction(
    c.env,
    principal,
    repo,
    { action: 'release.publish', ref: `${TAG_PREFIX}${tag}` },
    { exact, summary: { tag, ...summary } },
  );
}

async function tagHead(env: Env, repoId: string, tag: string): Promise<string> {
  const ref = await getRef(env, repoId, `${TAG_PREFIX}${tag}`);
  if (!ref) throw new ApiError(400, 'unknown_tag', `No tag ${tag}`, { tag });
  return ref.head;
}

/** `previous_tag`, else the newest published release on another tag. */
async function previousFor(
  env: Env,
  repoId: string,
  tag: string,
  explicit: string | undefined,
): Promise<{ tag: string; cs: string } | null> {
  if (explicit !== undefined)
    return { tag: explicit, cs: await tagHead(env, repoId, explicit) };
  const row = await q1<{ tag: string; target_cs: string }>(
    env,
    `SELECT tag, target_cs FROM releases WHERE repo_id = ? AND draft = 0 AND tag != ?
      ORDER BY published_at DESC, id DESC LIMIT 1`,
    [repoId, tag],
  );
  return row ? { tag: row.tag, cs: row.target_cs } : null;
}

async function assetCap(env: Env, repo: RepoWithCreator): Promise<number> {
  if (repo.owner_kind !== 'org' || !repo.owner_id) return DEFAULT_ASSET_MAX_BYTES;
  const row = await q1<{ asset_max_bytes: number }>(
    env,
    'SELECT asset_max_bytes FROM org_release_settings WHERE org_id = ?',
    [repo.owner_id],
  );
  return row?.asset_max_bytes ?? DEFAULT_ASSET_MAX_BYTES;
}

export const assetKey = (repoId: string, releaseId: string, assetId: string): string =>
  `releases/${repoId}/${releaseId}/${assetId}`;

// ---------------------------------------------------------------------------
// Releases
// ---------------------------------------------------------------------------

releasesRoutes.get(`${REPO}/releases`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'read', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const query = parse(listReleasesQuery, {
      cursor: c.req.query('cursor'),
      limit: c.req.query('limit'),
    });
    const limit = query.limit ?? 30;
    const drafts = await canWrite(c, loaded.repo);
    const rows = (
      await q(
        c.env,
        `SELECT * FROM releases WHERE repo_id = ? AND id < ? ${drafts ? '' : 'AND draft = 0'}
          ORDER BY id DESC LIMIT ?`,
        [loaded.repo.id, query.cursor ?? '\u{10ffff}', limit + 1],
      )
    ).map((r) => releaseRowSchema.parse(r));
    const page = rows.slice(0, limit);
    return c.json({
      releases: await views(c.env, page),
      next_cursor: rows.length > limit ? page[page.length - 1]!.id : null,
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

releasesRoutes.post(`${REPO}/releases`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'write', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const repo = loaded.repo;
    const scoped = requireAgentScope(c, 'releases:write');
    if (scoped) return scoped;
    const input = parse(createReleaseSchema, await readJsonBody(c));
    const target = await tagHead(c.env, repo.id, input.tag);
    let body = input.body ?? '';
    if (input.generate_notes) {
      const previous = await previousFor(c.env, repo.id, input.tag, input.previous_tag);
      const notes = await generateNotes(c.env, repo, {
        tag: input.tag,
        target,
        previous,
      });
      body = body ? `${body}\n\n${notes.body}` : notes.body;
    }
    const draft = input.draft ?? false;
    await judge(c, repo, input.tag, !draft, {
      action: 'create',
      target_cs: target,
      draft,
      body,
    });
    const now = Date.now();
    const id = ulid(now);
    try {
      await run(
        c.env,
        `INSERT INTO releases (id, repo_id, tag, target_cs, name, body, draft, prerelease,
           created_by, created_at, updated_at, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          repo.id,
          input.tag,
          target,
          input.name ?? input.tag,
          body,
          draft ? 1 : 0,
          input.prerelease ? 1 : 0,
          actorKey(principalOf(c)),
          now,
          now,
          draft ? null : now,
        ],
      );
    } catch (err) {
      if (String(err).includes('UNIQUE constraint failed'))
        throw new ApiError(
          409,
          'release_exists',
          `Tag ${input.tag} already has a release`,
        );
      throw err;
    }
    const release = await view(c.env, await getRow(c.env, id));
    await recordAudit(c, {
      action: 'release.create',
      repo,
      target: { release_id: id, tag: input.tag, target_cs: target, draft },
    });
    await emitRelease(c, repo, 'created', release);
    if (!draft) await emitRelease(c, repo, 'published', release);
    return c.json({ release }, 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

releasesRoutes.get(`${REPO}/releases/latest`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'read', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const id = await latestId(c.env, loaded.repo.id);
    if (!id) throw new ApiError(404, 'release_not_found', 'No published release yet');
    return c.json({ release: await view(c.env, await getRow(c.env, id)) });
  } catch (err) {
    return errorResponse(c, err);
  }
});

releasesRoutes.get(`${REPO}/releases/tags/:tag{.+}`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'read', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const row = await loadRelease(c, loaded.repo, { tag: c.req.param('tag') });
    return c.json({ release: await view(c.env, row) });
  } catch (err) {
    return errorResponse(c, err);
  }
});

releasesRoutes.post(`${REPO}/releases/generate-notes`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'write', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const repo = loaded.repo;
    const input = parse(generateNotesSchema, await readJsonBody(c));
    const target = await tagHead(c.env, repo.id, input.tag);
    const previous = await previousFor(c.env, repo.id, input.tag, input.previous_tag);
    return c.json(await generateNotes(c.env, repo, { tag: input.tag, target, previous }));
  } catch (err) {
    return errorResponse(c, err);
  }
});

releasesRoutes.get(`${REPO}/releases/:id`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'read', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const row = await loadRelease(c, loaded.repo, { id: c.req.param('id') });
    return c.json({ release: await view(c.env, row) });
  } catch (err) {
    return errorResponse(c, err);
  }
});

releasesRoutes.patch(`${REPO}/releases/:id`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'write', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const repo = loaded.repo;
    const scoped = requireAgentScope(c, 'releases:write');
    if (scoped) return scoped;
    const before = await loadRelease(c, repo, { id: c.req.param('id') });
    const input = parse(updateReleaseSchema, await readJsonBody(c));
    const draft = input.draft ?? before.draft === 1;
    const publishing = before.draft === 1 && !draft;
    await judge(c, repo, before.tag, before.draft === 0 || !draft, {
      action: 'update',
      release_id: before.id,
      ...input,
    });
    const now = Date.now();
    await run(
      c.env,
      `UPDATE releases SET name = ?, body = ?, draft = ?, prerelease = ?, updated_at = ?,
         published_at = ? WHERE id = ?`,
      [
        input.name ?? before.name,
        input.body ?? before.body,
        draft ? 1 : 0,
        (input.prerelease ?? before.prerelease === 1) ? 1 : 0,
        now,
        draft ? null : publishing ? now : before.published_at,
        before.id,
      ],
    );
    const release = await view(c.env, await getRow(c.env, before.id));
    await recordAudit(c, {
      action: 'release.update',
      repo,
      target: {
        release_id: before.id,
        tag: before.tag,
        fields: Object.keys(input),
        published: publishing,
      },
    });
    await emitRelease(c, repo, publishing ? 'published' : 'edited', release);
    return c.json({ release });
  } catch (err) {
    return errorResponse(c, err);
  }
});

releasesRoutes.delete(`${REPO}/releases/:id`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'write', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const repo = loaded.repo;
    const scoped = requireAgentScope(c, 'releases:write');
    if (scoped) return scoped;
    const row = await loadRelease(c, repo, { id: c.req.param('id') });
    await judge(c, repo, row.tag, row.draft === 0, {
      action: 'delete',
      release_id: row.id,
    });
    const release = await view(c.env, row);
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM release_attestations WHERE release_id = ?').bind(
        row.id,
      ),
      c.env.DB.prepare('DELETE FROM release_assets WHERE release_id = ?').bind(row.id),
      c.env.DB.prepare('DELETE FROM releases WHERE id = ?').bind(row.id),
    ]);
    if (release.assets.length > 0)
      await c.env.OBJECTS.delete(
        release.assets.map((a) => assetKey(repo.id, row.id, a.id)),
      );
    await recordAudit(c, {
      action: 'release.delete',
      repo,
      target: { release_id: row.id, tag: row.tag, assets: release.assets.length },
    });
    await emitRelease(c, repo, 'deleted', release);
    return c.body(null, 204);
  } catch (err) {
    return errorResponse(c, err);
  }
});

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

releasesRoutes.post(`${REPO}/releases/:id/assets`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'write', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const repo = loaded.repo;
    const scoped = requireAgentScope(c, 'releases:write');
    if (scoped) return scoped;
    const release = await loadRelease(c, repo, { id: c.req.param('id') });
    const query = parse(uploadAssetQuery, {
      name: c.req.query('name'),
      sha256: c.req.query('sha256'),
    });
    const length = Number(c.req.header('content-length') ?? NaN);
    if (!Number.isSafeInteger(length) || length < 0)
      throw new ApiError(411, 'length_required', 'Send the asset with a Content-Length');
    if (length === 0) throw new ApiError(400, 'empty_asset', 'The asset is empty');
    const cap = await assetCap(c.env, repo);
    if (length > cap)
      throw new ApiError(413, 'asset_too_large', `Assets are limited to ${cap} bytes`, {
        max_bytes: cap,
      });
    const existing = await q<{ name: string }>(
      c.env,
      'SELECT name FROM release_assets WHERE release_id = ?',
      [release.id],
    );
    if (existing.some((a) => a.name === query.name))
      throw new ApiError(409, 'asset_exists', `Asset ${query.name} already exists`);
    if (existing.length >= MAX_ASSETS)
      throw new ApiError(409, 'too_many_assets', `A release keeps ${MAX_ASSETS} assets`);
    // a CI job proves which run uploaded the asset; only that run may attest it
    const idToken = c.req.header('x-yag-id-token');
    const runId = idToken ? (await ciJob(c, repo, idToken)).job.id : null;
    await judge(c, repo, release.tag, release.draft === 0, {
      action: 'asset.upload',
      release_id: release.id,
      name: query.name,
      size: length,
      sha256: query.sha256 ?? null,
    });

    const type = c.req.header('content-type')?.split(';')[0]?.trim() ?? '';
    const contentType = CONTENT_TYPE.test(type) ? type : 'application/octet-stream';
    const id = ulid();
    const key = assetKey(repo.id, release.id, id);
    // Hash as the bytes stream to R2; the fixed length makes R2 refuse a short body.
    const hasher = new IncrementalSha256();
    const fixed = new FixedLengthStream(length);
    const body = c.req.raw.body;
    if (!body) throw new ApiError(400, 'empty_asset', 'The asset is empty');
    const piping = body
      .pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            hasher.update(chunk);
            controller.enqueue(chunk);
          },
        }),
      )
      .pipeTo(fixed.writable);
    await Promise.all([
      c.env.OBJECTS.put(key, fixed.readable, { httpMetadata: { contentType } }),
      piping,
    ]);
    const sha256 = hasher.digestHex();
    if (query.sha256 !== undefined && query.sha256 !== sha256) {
      await c.env.OBJECTS.delete(key);
      throw new ApiError(
        400,
        'checksum_mismatch',
        'The uploaded bytes do not match sha256',
        {
          expected: query.sha256,
          actual: sha256,
        },
      );
    }
    const principal = principalOf(c);
    const row: AssetRow = {
      id,
      release_id: release.id,
      name: query.name,
      content_type: contentType,
      size: length,
      sha256,
      uploaded_by: actorKey(principal),
      run_id: runId,
      created_at: Date.now(),
    };
    try {
      await run(
        c.env,
        `INSERT INTO release_assets (id, release_id, repo_id, name, content_type, size, sha256,
           uploaded_by, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          release.id,
          repo.id,
          row.name,
          row.content_type,
          row.size,
          row.sha256,
          row.uploaded_by,
          row.run_id,
          row.created_at,
        ],
      );
    } catch (err) {
      await c.env.OBJECTS.delete(key);
      if (String(err).includes('UNIQUE constraint failed'))
        throw new ApiError(409, 'asset_exists', `Asset ${query.name} already exists`);
      throw err;
    }
    await recordAudit(c, {
      action: 'release.asset.upload',
      repo,
      target: {
        release_id: release.id,
        tag: release.tag,
        asset_id: id,
        name: row.name,
        size: row.size,
        sha256,
        run_id: runId,
      },
    });
    return c.json({ asset: assetView(row) }, 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

releasesRoutes.get(`${REPO}/releases/:id/assets/:asset`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'read', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const release = await loadRelease(c, loaded.repo, { id: c.req.param('id') });
    const found = await q1(
      c.env,
      'SELECT * FROM release_assets WHERE release_id = ? AND id = ?',
      [release.id, c.req.param('asset')],
    );
    if (!found) throw new ApiError(404, 'asset_not_found', 'No such asset');
    const asset = assetRowSchema.parse(found);
    const object = await c.env.OBJECTS.get(
      assetKey(loaded.repo.id, release.id, asset.id),
    );
    if (!object) throw new ApiError(404, 'asset_missing', 'The asset bytes are missing');
    // Checked against the stored SHA-256 while streaming: a mismatch aborts
    // the response, so a client never receives altered bytes as complete.
    const hasher = new IncrementalSha256();
    let size = 0;
    const stream = object.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          hasher.update(chunk);
          size += chunk.byteLength;
          controller.enqueue(chunk);
        },
        flush() {
          if (size !== asset.size || hasher.digestHex() !== asset.sha256) {
            console.error('release asset failed its checksum', asset.id);
            throw new Error('release asset does not match its stored SHA-256');
          }
        },
      }),
    );
    const digest = btoa(
      String.fromCharCode(
        ...(asset.sha256.match(/../g) ?? []).map((h) => parseInt(h, 16)),
      ),
    );
    return new Response(stream, {
      headers: {
        'content-type': asset.content_type,
        'content-disposition': `attachment; filename="${asset.name}"`,
        'content-security-policy': 'sandbox',
        'x-content-type-options': 'nosniff',
        'repr-digest': `sha-256=:${digest}:`,
        'x-yag-sha256': asset.sha256,
        'cache-control': NO_STORE,
      },
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

releasesRoutes.delete(`${REPO}/releases/:id/assets/:asset`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'write', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const repo = loaded.repo;
    const scoped = requireAgentScope(c, 'releases:write');
    if (scoped) return scoped;
    const release = await loadRelease(c, repo, { id: c.req.param('id') });
    const found = await q1(
      c.env,
      'SELECT * FROM release_assets WHERE release_id = ? AND id = ?',
      [release.id, c.req.param('asset')],
    );
    if (!found) throw new ApiError(404, 'asset_not_found', 'No such asset');
    const asset = assetRowSchema.parse(found);
    await judge(c, repo, release.tag, release.draft === 0, {
      action: 'asset.delete',
      release_id: release.id,
      asset_id: asset.id,
    });
    await run(c.env, 'DELETE FROM release_assets WHERE id = ?', [asset.id]);
    await c.env.OBJECTS.delete(assetKey(repo.id, release.id, asset.id));
    await recordAudit(c, {
      action: 'release.asset.delete',
      repo,
      target: {
        release_id: release.id,
        tag: release.tag,
        asset_id: asset.id,
        name: asset.name,
      },
    });
    return c.body(null, 204);
  } catch (err) {
    return errorResponse(c, err);
  }
});

// ---------------------------------------------------------------------------
// Build provenance
// ---------------------------------------------------------------------------

releasesRoutes.get(`${REPO}/releases/:id/attestations`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'read', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const release = await loadRelease(c, loaded.repo, { id: c.req.param('id') });
    const rows = (
      await q(
        c.env,
        `SELECT id, release_id, run_id, key_id, envelope, created_by, created_at
           FROM release_attestations WHERE release_id = ? ORDER BY id`,
        [release.id],
      )
    ).map((r) => attestationRowSchema.parse(r));
    return c.json({
      attestations: rows.map((r) => ({
        id: r.id,
        run_id: r.run_id,
        key_id: r.key_id,
        subjects: subjectsOf(r.envelope),
        created_by: r.created_by,
        created_at: r.created_at,
        envelope: JSON.parse(r.envelope) as unknown,
      })),
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

releasesRoutes.post(`${REPO}/releases/:id/attestations`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'write', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const repo = loaded.repo;
    const scoped = requireAgentScope(c, 'releases:write');
    if (scoped) return scoped;
    const release = await loadRelease(c, repo, { id: c.req.param('id') });
    const input = parse(attestSchema, await readJsonBody(c));
    const origin = new URL(c.req.url).origin;
    const { claims, job } = await ciJob(c, repo, input.id_token);
    if (job.head_cs !== release.target_cs)
      throw new ApiError(
        409,
        'provenance_source_mismatch',
        `Run ${job.id} built ${job.head_cs}, not the release target ${release.target_cs}`,
        { run_cs: job.head_cs, target_cs: release.target_cs },
      );
    const assets = (
      await q(c.env, 'SELECT * FROM release_assets WHERE release_id = ? ORDER BY name', [
        release.id,
      ])
    ).map((r) => assetRowSchema.parse(r));
    // #58: a run attests only bytes its own jobs uploaded, never a person's upload
    const chosen = input.assets
      ? assets.filter((a) => input.assets!.includes(a.name))
      : assets.filter((a) => a.run_id === job.id);
    const missing = (input.assets ?? []).filter((n) => !assets.some((a) => a.name === n));
    if (missing.length > 0)
      throw new ApiError(400, 'unknown_asset', `No asset ${missing.join(', ')}`);
    const foreign = chosen.filter((a) => a.run_id !== job.id).map((a) => a.name);
    if (foreign.length > 0)
      throw new ApiError(
        409,
        'asset_not_from_run',
        `Run ${job.id} did not upload ${foreign.join(', ')}`,
        { assets: foreign },
      );
    if (chosen.length === 0)
      throw new ApiError(
        400,
        'no_assets',
        `Run ${job.id} uploaded no assets to this release; upload them from the job first`,
      );
    const subjects = chosen.map((a) => ({ name: a.name, digest: { sha256: a.sha256 } }));
    await judge(c, repo, release.tag, release.draft === 0, {
      action: 'attest',
      release_id: release.id,
      run_id: job.id,
      subjects,
    });
    const statement = buildProvenance({
      origin,
      slug: repo.slug,
      claims,
      run: job,
      subjects,
    });
    const { envelope, keyId } = await signEnvelope(c.env, statement);
    const principal = principalOf(c);
    const now = Date.now();
    const id = ulid(now);
    await run(
      c.env,
      `INSERT INTO release_attestations (id, release_id, repo_id, run_id, key_id, envelope,
         created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        release.id,
        repo.id,
        job.id,
        keyId,
        JSON.stringify(envelope),
        actorKey(principal),
        now,
      ],
    );
    await recordAudit(c, {
      action: 'release.attest',
      repo,
      target: {
        release_id: release.id,
        tag: release.tag,
        attestation_id: id,
        run_id: job.id,
        key_id: keyId,
        subjects,
      },
    });
    return c.json(
      {
        attestation: {
          id,
          run_id: job.id,
          key_id: keyId,
          subjects,
          created_by: actorKey(principal),
          created_at: now,
          envelope,
        },
      },
      201,
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

releasesRoutes.post(`${REPO}/attestations/verify`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'read', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const input = parse(verifyAttestationSchema, await readJsonBody(c));
    const check = await verifyEnvelope(c.env, input.envelope);
    if (!check.verified) return c.json({ verified: false, reason: check.reason });
    const statement = z
      .looseObject({
        _type: z.literal('https://in-toto.io/Statement/v1'),
        subject: z.array(
          z.object({ name: z.string(), digest: z.record(z.string(), z.string()) }),
        ),
        predicateType: z.string(),
      })
      .safeParse(check.statement);
    if (!statement.success)
      return c.json({ verified: false, reason: 'payload is not an in-toto statement' });
    const subject = input.sha256
      ? statement.data.subject.find((s) => s.digest.sha256 === input.sha256)
      : undefined;
    if (input.sha256 && !subject)
      return c.json({ verified: false, reason: 'no subject has this sha256' });
    return c.json({
      verified: true,
      key_id: check.key_id,
      predicate_type: statement.data.predicateType,
      subject: subject ?? null,
      statement: check.statement,
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

// ---------------------------------------------------------------------------
// Org settings
// ---------------------------------------------------------------------------

releasesRoutes.get('/orgs/:org/release-settings', async (c) => {
  try {
    const { org } = await loadOrg(c, 'member');
    const row = await q1<{ asset_max_bytes: number }>(
      c.env,
      'SELECT asset_max_bytes FROM org_release_settings WHERE org_id = ?',
      [org.id],
    );
    return c.json({
      asset_max_bytes: row?.asset_max_bytes ?? DEFAULT_ASSET_MAX_BYTES,
      default: row === null,
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

releasesRoutes.put('/orgs/:org/release-settings', async (c) => {
  try {
    const { org } = await loadOrg(c, 'owner');
    const input = parse(releaseSettingsSchema, await readJsonBody(c));
    const principal = principalOf(c);
    await run(
      c.env,
      `INSERT INTO org_release_settings (org_id, asset_max_bytes, updated_by, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (org_id) DO UPDATE SET asset_max_bytes = excluded.asset_max_bytes,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      [org.id, input.asset_max_bytes, principal.userId, Date.now()],
    );
    await recordAudit(c, {
      action: 'org.release_settings.set',
      orgId: org.slug,
      target: { org: org.slug, asset_max_bytes: input.asset_max_bytes },
    });
    return c.json({ asset_max_bytes: input.asset_max_bytes, default: false });
  } catch (err) {
    return errorResponse(c, err);
  }
});
