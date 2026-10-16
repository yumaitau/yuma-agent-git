import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../auth/principal';
import { ApiError } from '../../core/errors';
import { blobIdsFor, treeIdsFor } from '../../git/mapping';
import { gitBlobId } from '../../git/objects';
import {
  apiUrl,
  changesetOf,
  gh,
  ghBody,
  iso,
  loadRepo,
  native,
  originOf,
  parseGh,
  param,
  PREFIX,
  shaOf,
  shasOf,
  type Ctx,
  type Repo,
} from './native';

/** Contents, Git refs and commits, mapped onto file/tree, refs and changesets. */
export const contentsRoutes = new Hono<AppEnv>();
const REPO = `${PREFIX}/repos/:owner/:repo`;

const fileSchema = z.object({
  path: z.string(),
  size: z.number(),
  cs: z.string(),
  content_b64: z.string(),
});
const treeSchema = z.object({
  entries: z.array(
    z.object({
      name: z.string(),
      kind: z.enum(['tree', 'blob']),
      hash: z.string(),
      size: z.number().optional(),
    }),
  ),
});

function b64Bytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
}

async function contents(c: Ctx, path: string): Promise<Response> {
  const repo = await loadRepo(c);
  const cs = await changesetOf(c, repo, c.req.query('ref') ?? repo.record.default_branch);
  const at = (p: string) => `${repo.path}/${p}?cs=${cs}&path=${encodeURIComponent(path)}`;
  const item = (name: string, p: string, type: 'file' | 'dir', sha: string | null) => ({
    name,
    path: p,
    sha,
    type,
    url: apiUrl(c, `/repos/${repo.record.slug}/contents/${p}?ref=${cs}`),
    html_url: `${originOf(c)}/r/${repo.record.slug}/tree/${cs}/${p}`,
  });
  if (path !== '') {
    try {
      const file = fileSchema.parse(await native(c, 'GET', at('file')));
      const bytes = b64Bytes(file.content_b64);
      const name = path.split('/').pop() as string;
      return c.json({
        ...item(name, path, 'file', (await gitBlobId(bytes)).sha1),
        size: file.size,
        encoding: 'base64',
        content: file.content_b64,
      });
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'path_not_found')) throw err;
    }
  }
  const tree = treeSchema.parse(await native(c, 'GET', at('tree')));
  const blobs = await blobIdsFor(
    c.env,
    tree.entries.filter((e) => e.kind === 'blob').map((e) => e.hash),
  );
  const trees = await treeIdsFor(
    c.env,
    repo.record.id,
    tree.entries.filter((e) => e.kind === 'tree').map((e) => e.hash),
  );
  return c.json(
    tree.entries.map((e) => ({
      ...item(
        e.name,
        path === '' ? e.name : `${path}/${e.name}`,
        e.kind === 'blob' ? 'file' : 'dir',
        (e.kind === 'blob' ? blobs : trees).get(e.hash)?.sha1 ?? null,
      ),
      size: e.size ?? 0,
    })),
  );
}

contentsRoutes.get(
  `${REPO}/contents`,
  gh((c) => contents(c, '')),
);
contentsRoutes.get(
  `${REPO}/contents/:path{.+}`,
  gh((c) => contents(c, param(c, 'path'))),
);

// ---------------------------------------------------------------------------
// Git refs: branches are short names in the forge, tags `refs/tags/<t>`.
// ---------------------------------------------------------------------------

const refSchema = z.object({ name: z.string(), head: z.string() });

async function ghRef(c: Ctx, repo: Repo, name: string, head: string) {
  const ref = name.startsWith('refs/') ? name : `refs/heads/${name}`;
  const sha = await shaOf(c, repo.record.id, head);
  return {
    ref,
    node_id: `${repo.record.id}:ref:${ref}`,
    url: apiUrl(c, `/repos/${repo.record.slug}/git/${ref}`),
    object: {
      sha,
      type: 'commit',
      url: apiUrl(c, `/repos/${repo.record.slug}/git/commits/${sha}`),
    },
  };
}

/** `heads/<b>` → `<b>`, `tags/<t>` → `refs/tags/<t>` (the forge's names). */
function forgeRef(ref: string): string {
  const short = ref.replace(/^refs\//, '');
  if (short.startsWith('heads/')) return short.slice('heads/'.length);
  if (short.startsWith('tags/')) return `refs/${short}`;
  throw new ApiError(422, 'validation_failed', 'ref must start with heads/ or tags/');
}

contentsRoutes.get(
  `${REPO}/git/ref/:ref{.+}`,
  gh(async (c) => {
    const repo = await loadRepo(c);
    const name = forgeRef(param(c, 'ref'));
    const ref = refSchema.parse(
      await native(c, 'GET', `${repo.path}/refs/${encodeURI(name)}`),
    );
    return c.json(await ghRef(c, repo, ref.name, ref.head));
  }),
);

export const createGitRefBody = z.object({
  ref: z.string().regex(/^refs\/(heads|tags)\/.+/, 'ref must be fully qualified'),
  sha: z.string().min(1),
});

contentsRoutes.post(
  `${REPO}/git/refs`,
  gh(async (c) => {
    const repo = await loadRepo(c);
    const input = parseGh(createGitRefBody, await ghBody(c));
    const name = forgeRef(input.ref);
    const cs = await changesetOf(c, repo, input.sha);
    if (name.startsWith('refs/tags/')) {
      await native(c, 'POST', `${repo.path}/tags`, {
        name: name.slice('refs/tags/'.length),
        target: cs,
      });
    } else {
      await native(c, 'PUT', `${repo.path}/refs/${encodeURI(name)}`, {
        from: null,
        to: cs,
      });
    }
    return c.json(await ghRef(c, repo, name, cs), 201);
  }),
);

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

const changesetSchema = z.object({
  changeset: z.looseObject({
    id: z.string(),
    parents: z.array(z.string()),
    message: z.string(),
    created_at: z.number(),
    author: z.union([
      z.object({ name: z.string(), email: z.string() }),
      z.object({ agent: z.string() }),
    ]),
  }),
});

contentsRoutes.get(
  `${REPO}/commits/:ref`,
  gh(async (c) => {
    const repo = await loadRepo(c);
    const id = await changesetOf(c, repo, param(c, 'ref'));
    const { changeset: cs } = changesetSchema.parse(
      await native(c, 'GET', `${repo.path}/changesets/${id}`),
    );
    const shas = await shasOf(c, repo.record.id, [cs.id, ...cs.parents]);
    const sha = shas.get(cs.id) as string;
    const author =
      'agent' in cs.author ? { name: cs.author.agent, email: '' } : cs.author;
    const signature = { ...author, date: iso(cs.created_at) };
    return c.json({
      sha,
      node_id: `${repo.record.id}:commit:${cs.id}`,
      changeset: cs.id,
      url: apiUrl(c, `/repos/${repo.record.slug}/commits/${sha}`),
      html_url: `${originOf(c)}/r/${repo.record.slug}/cs/${cs.id}`,
      commit: { message: cs.message, author: signature, committer: signature },
      parents: cs.parents.map((p) => ({
        sha: shas.get(p),
        url: apiUrl(c, `/repos/${repo.record.slug}/commits/${shas.get(p)}`),
      })),
    });
  }),
);
