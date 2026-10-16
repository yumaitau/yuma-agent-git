import type { Context } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';
import type { RepoRecord } from '../db/client';
import { agentIdOf, type AppEnv, type Principal } from '../auth/principal';
import { recordAgentProvenance } from '../auth/agents';
import { pathDecider, restrictingDecision } from '../auth/rbac';
import { actorOf, recordAudit } from '../audit/record';
import { ciReady, pushPipelines } from '../ci/triggers';
import { linkLanded } from '../collab/references';
import { recordOutcome } from '../policy/rulesets';
import { listRefs, getRef } from '../db/repos';
import { hasBlob, putBlob } from '../core/blobs';
import { MAX_CHANGED_FILES } from '../core/changesets';
import { commitChanges, type Change } from '../core/commit';
import { isAncestorDag } from '../core/ancestry';
import { ApiError } from '../core/errors';
import {
  AGENT_PREFIX,
  TAG_PREFIX,
  agentRefOwner,
  moveRefViaDO,
  validateBranchName,
  validateRefName,
  type RefsMode,
} from '../core/refs';
import { changesetForSha1, readGitObject, resolveSha1 } from './mapping';
import {
  EMPTY_TREE,
  TREE_MODE,
  parseCommit,
  parseTree,
  type GitTreeItem,
  type ParsedCommit,
} from './objects';
import { PackError, readPack, type PackedObject } from './pack-reader';
import {
  concatBytes,
  FLUSH,
  GitProtocolError,
  PktReader,
  pktLine,
  pktText,
  sideband,
} from './pktline';
import {
  preReceive,
  type GitChange,
  type PushCommit,
  type PushUpdate,
} from './pre-receive';
import { AGENT, commitShas } from './upload-pack';

/**
 * receive-pack (issue #32): `git push` over smart HTTP, protocol v0 (Git has
 * no v2 push). A push is handled in phases so nothing becomes visible until
 * every check has passed:
 *
 *  1. parse the commands and the pack (`pack-reader.ts`, caps below)
 *  2. walk each update's new commits and diff each against its first parent
 *  3. pre-receive checks (`pre-receive.ts`)
 *  4. store blobs and create changesets with `commitChanges`, parents first,
 *     keeping author, committer, time zones and signature; each new
 *     changeset must rebuild to the pushed commit SHA or the push fails
 *  5. one compare-and-swap per ref through `moveRefViaDO`; with `atomic`, a
 *     failed move puts the refs already moved back
 *  6. start pipelines whose push trigger matches (`ci/triggers.ts`)
 *
 * Packs are held in memory, so they are capped (`PUSH_LIMITS`). Larger pushes
 * are refused with a clear message instead of spilling to R2. A changeset row
 * holds its whole change list, so a commit may change at most
 * `MAX_CHANGED_FILES` paths against its first parent; a commit over that is
 * refused before anything in its update is stored.
 */

export const PUSH_LIMITS = {
  maxPackBytes: 24 * 1024 * 1024,
  maxObjects: 100_000,
  maxObjectBytes: 48 * 1024 * 1024,
  maxTotalBytes: 48 * 1024 * 1024,
};

const ZERO_SHA = '0'.repeat(40);
const CAPABILITIES = [
  'report-status',
  'delete-refs',
  'side-band-64k',
  'quiet',
  'atomic',
  'ofs-delta',
  'object-format=sha1',
  AGENT,
].join(' ');
const BLOB_MODES = new Set(['100644', '100755', '120000', '160000']);

class PushError extends Error {}

/** Refs this principal may see in a push advertisement (own agent refs only). */
function visibleToPusher(name: string, principal: Principal): boolean {
  if (!name.startsWith(AGENT_PREFIX)) return true;
  const id = agentIdOf(principal);
  return id !== null && agentRefOwner(name) === id;
}

export async function advertiseReceivePack(
  env: Env,
  repo: RepoRecord,
  principal: Principal,
): Promise<Uint8Array> {
  const refs = (await listRefs(env, repo.id)).filter((r) =>
    visibleToPusher(r.name, principal),
  );
  const shas = await commitShas(
    env,
    repo.id,
    refs.map((r) => r.head),
  );
  const lines = refs.map(
    (r) =>
      `${shas.get(r.head)} ${r.name.startsWith('refs/') ? r.name : `refs/heads/${r.name}`}`,
  );
  if (lines.length === 0) lines.push(`${ZERO_SHA} capabilities^{}`);
  lines[0] = `${lines[0]}\0${CAPABILITIES}`;
  return concatBytes([
    pktLine('# service=git-receive-pack\n'),
    FLUSH,
    ...lines.map((l) => pktLine(`${l}\n`)),
    FLUSH,
  ]);
}

/** Git ref → forge ref name; branches drop `refs/heads/`. */
function forgeRefName(ref: string, mode: RefsMode): string {
  if (ref.startsWith('refs/heads/'))
    return validateBranchName(ref.slice('refs/heads/'.length), mode);
  if (ref.startsWith(TAG_PREFIX) || ref.startsWith(AGENT_PREFIX)) {
    return validateRefName(ref, mode);
  }
  throw new PushError('only refs/heads/*, refs/tags/* and refs/agents/* can be pushed');
}

interface Push {
  env: Env;
  repoId: string;
  objects: Map<string, PackedObject>;
  parsed: Map<string, ParsedCommit>;
  csOf: Map<string, string>;
  trees: Map<string, GitTreeItem[]>;
}

function packCommit(push: Push, sha: string): ParsedCommit | null {
  const cached = push.parsed.get(sha);
  if (cached) return cached;
  const object = push.objects.get(sha);
  if (!object || object.type !== 'commit') return null;
  let commit: ParsedCommit;
  try {
    commit = parseCommit(object.body);
  } catch (err) {
    throw new PushError(`commit ${sha} cannot be stored: ${(err as Error).message}`);
  }
  push.parsed.set(sha, commit);
  return commit;
}

async function existingCommit(push: Push, sha: string): Promise<string | null> {
  const known = push.csOf.get(sha);
  if (known) return known;
  const id = await changesetForSha1(push.env, push.repoId, sha);
  if (id) push.csOf.set(sha, id);
  return id;
}

/** Tree SHA of a pushed or stored commit. */
async function treeOf(push: Push, sha: string): Promise<string> {
  const commit = packCommit(push, sha);
  if (commit) return commit.tree;
  const object = await readGitObject(push.env, push.repoId, sha);
  if (!object || object.type !== 'commit') throw new PushError(`missing commit ${sha}`);
  return parseCommit(object.body).tree;
}

async function readTree(push: Push, sha: string): Promise<GitTreeItem[]> {
  if (sha === EMPTY_TREE.sha1) return [];
  const cached = push.trees.get(sha);
  if (cached) return cached;
  const object =
    push.objects.get(sha) ?? (await readGitObject(push.env, push.repoId, sha));
  if (!object || object.type !== 'tree') throw new PushError(`missing tree ${sha}`);
  let items: GitTreeItem[];
  try {
    items = parseTree(object.body);
  } catch (err) {
    throw new PushError(`tree ${sha}: ${(err as Error).message}`);
  }
  for (const item of items) {
    if (item.mode !== TREE_MODE && !BLOB_MODES.has(item.mode)) {
      throw new PushError(
        `tree ${sha} has unsupported mode ${item.mode} for ${item.name}`,
      );
    }
  }
  push.trees.set(sha, items);
  return items;
}

/** File changes from tree `base` to tree `target` (either may be absent). */
async function diffTrees(
  push: Push,
  base: string | null,
  target: string | null,
  prefix: string,
  out: Pick<PushCommit, 'changes' | 'trees'>,
): Promise<void> {
  if (base === target) return;
  const before = new Map(
    (base ? await readTree(push, base) : []).map((e) => [e.name, e]),
  );
  const after = target ? await readTree(push, target) : [];
  if (target) out.trees.push({ path: prefix, names: after.map((e) => e.name) });
  const path = (name: string): string => (prefix === '' ? name : `${prefix}/${name}`);
  const isTree = (e: GitTreeItem | undefined): boolean => e?.mode === TREE_MODE;
  const file = (op: GitChange['op'], e: GitTreeItem): GitChange => {
    const object = push.objects.get(e.sha);
    return {
      path: path(e.name),
      op,
      sha: e.sha,
      mode: e.mode,
      size: object?.body.length,
    };
  };
  for (const entry of after) {
    const old = before.get(entry.name);
    before.delete(entry.name);
    if (old && old.sha === entry.sha && old.mode === entry.mode) continue;
    if (isTree(entry)) {
      if (old && !isTree(old)) out.changes.push({ path: path(old.name), op: 'del' });
      await diffTrees(
        push,
        isTree(old) ? (old as GitTreeItem).sha : null,
        entry.sha,
        path(entry.name),
        out,
      );
    } else {
      if (isTree(old))
        await diffTrees(push, (old as GitTreeItem).sha, null, path(entry.name), out);
      out.changes.push(file(old && !isTree(old) ? 'mod' : 'add', entry));
    }
  }
  for (const old of before.values()) {
    if (isTree(old)) await diffTrees(push, old.sha, null, path(old.name), out);
    else out.changes.push({ path: path(old.name), op: 'del' });
  }
}

/**
 * New commits reachable from `sha`, parents before children. A pushed commit
 * that already maps to a changeset is not new, even when the pack carries it.
 */
async function newCommits(push: Push, sha: string): Promise<string[]> {
  const order: string[] = [];
  const seen = new Set<string>();
  const stack: { sha: string; next: number }[] = [];
  const enter = async (s: string): Promise<void> => {
    if (seen.has(s)) return;
    seen.add(s);
    if ((await existingCommit(push, s)) !== null) return;
    if (packCommit(push, s)) stack.push({ sha: s, next: 0 });
    else throw new PushError(`missing commit ${s}`);
  };
  await enter(sha);
  while (stack.length > 0) {
    const top = stack[stack.length - 1] as { sha: string; next: number };
    const parents = (packCommit(push, top.sha) as ParsedCommit).parents;
    if (top.next < parents.length) {
      await enter(parents[top.next++] as string);
      continue;
    }
    stack.pop();
    order.push(top.sha);
  }
  return order;
}

/** Whether changeset `from` is an ancestor of commit `sha` (pushed or stored). */
async function descendsFrom(push: Push, from: string, sha: string): Promise<boolean> {
  const queue = [sha];
  const seen = new Set(queue);
  for (let i = 0; i < queue.length; i++) {
    const s = queue[i] as string;
    const commit = packCommit(push, s);
    if (commit) {
      for (const p of commit.parents) {
        if (seen.has(p)) continue;
        seen.add(p);
        queue.push(p);
      }
      continue;
    }
    const id = await existingCommit(push, s);
    if (
      id !== null &&
      (id === from || (await isAncestorDag(push.env, push.repoId, from, id)))
    ) {
      return true;
    }
  }
  return false;
}

/** One-line reason for `ng <ref> <reason>`. */
function reason(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`;
  if (err instanceof PushError || err instanceof GitProtocolError) return err.message;
  if (err instanceof z.ZodError) {
    return `commit cannot be stored: ${err.issues[0]?.message ?? 'invalid'}`;
  }
  console.error('receive-pack: unexpected error', err);
  return 'internal error';
}

function statusReport(
  updates: PushUpdate[],
  unpack: string,
  useSideband: boolean,
  messages: string[],
): Uint8Array {
  const status = concatBytes([
    pktLine(`unpack ${unpack}\n`),
    ...updates.map((u) =>
      pktLine(
        u.error ? `ng ${u.ref} ${u.error.replace(/\s+/g, ' ')}\n` : `ok ${u.ref}\n`,
      ),
    ),
    FLUSH,
  ]);
  if (!useSideband) return status;
  return concatBytes([
    ...messages.flatMap((m) => sideband(2, `${m}\n`)),
    ...sideband(1, status),
    FLUSH,
  ]);
}

/** Handle one POST git-receive-pack body; returns the response body. */
export async function receivePack(
  c: Context<AppEnv>,
  repo: RepoRecord,
  body: Uint8Array,
): Promise<Uint8Array> {
  const env = c.env;
  const principal = c.get('principal') as Principal;

  // 1. commands, then the pack
  const reader = new PktReader(body);
  const updates: PushUpdate[] = [];
  let caps: string[] = [];
  for (;;) {
    const pkt = reader.next();
    if (pkt === null) throw new GitProtocolError('push ended before the command list');
    if (pkt.kind === 'flush') break;
    if (pkt.kind !== 'data')
      throw new GitProtocolError('unexpected packet in command list');
    let line = pktText(pkt.data);
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      if (updates.length === 0) caps = line.slice(nul + 1).split(' ');
      line = line.slice(0, nul);
    }
    if (line.startsWith('shallow ')) continue; // our history is complete
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (!m) throw new GitProtocolError(`malformed push command ${JSON.stringify(line)}`);
    updates.push({
      ref: m[3] as string,
      name: '',
      oldSha: m[1] as string,
      newSha: m[2] as string,
      from: null,
      deleting: m[2] === ZERO_SHA,
      fastForward: true,
      commits: [],
    });
  }
  if (updates.length === 0) return FLUSH;
  const useSideband = caps.includes('side-band-64k');
  const atomic = caps.includes('atomic');
  const messages: string[] = [];

  const push: Push = {
    env,
    repoId: repo.id,
    objects: new Map(),
    parsed: new Map(),
    csOf: new Map(),
    trees: new Map(),
  };
  const pack = body.subarray(reader.offset);
  if (pack.length > 0) {
    try {
      push.objects = await readPack(pack, PUSH_LIMITS, async (sha) => {
        const object = await readGitObject(env, repo.id, sha);
        return object ? { type: object.type, body: object.body } : null;
      });
    } catch (err) {
      if (!(err instanceof PackError)) throw err;
      for (const u of updates) u.error = 'unpacker error';
      return statusReport(updates, err.message.replace(/\s+/g, ' '), useSideband, [
        `pack rejected: ${err.message}`,
      ]);
    }
  }

  // 2. resolve each update and walk its new commits
  const commits = new Map<string, PushCommit>();
  for (const u of updates) {
    try {
      u.name = forgeRefName(u.ref, repo.refs_mode ?? 'scion');
      if (u.oldSha !== ZERO_SHA) {
        u.from = await existingCommit(push, u.oldSha);
        if (u.from === null) throw new PushError('stale info: fetch first');
      }
      const current = await getRef(env, repo.id, u.name);
      if ((current?.head ?? null) !== u.from)
        throw new PushError('stale info: fetch first');
      if (u.deleting) continue;
      const object = push.objects.get(u.newSha);
      if (object?.type === 'tag') {
        throw new PushError(
          'annotated tags are not supported yet; push a lightweight tag',
        );
      }
      if (object && object.type !== 'commit')
        throw new PushError(`${u.newSha} is not a commit`);
      u.commits = await newCommits(push, u.newSha);
      for (const sha of u.commits) {
        if (commits.has(sha)) continue;
        const commit = packCommit(push, sha) as ParsedCommit;
        const first = commit.parents[0];
        const entry: PushCommit = { sha, changes: [], trees: [] };
        await diffTrees(
          push,
          first ? await treeOf(push, first) : null,
          commit.tree,
          '',
          entry,
        );
        if (entry.changes.length > MAX_CHANGED_FILES) {
          throw new PushError(
            `commit ${sha} changes ${entry.changes.length} paths; at most ${MAX_CHANGED_FILES} per commit can be stored`,
          );
        }
        commits.set(sha, entry);
      }
      if (u.from !== null) u.fastForward = await descendsFrom(push, u.from, u.newSha);
    } catch (err) {
      u.error = reason(err);
    }
  }

  // 3. pre-receive checks
  const pending = updates.filter((u) => !u.error);
  const decider = await pathDecider(env, repo, principal);
  const verdicts = await preReceive(
    {
      env,
      repo,
      principal,
      decider,
      commits,
      async refChanges(u) {
        const out = { changes: [] as GitChange[], trees: [] };
        const head = u.deleting ? null : await treeOf(push, u.newSha);
        await diffTrees(push, await treeOf(push, u.oldSha), head, '', out);
        return out.changes;
      },
    },
    pending,
  );
  for (const u of pending) {
    const verdict = verdicts.get(u.ref);
    if (!verdict) continue;
    u.error = `${verdict.rule}: ${verdict.message}`;
    messages.push(`${u.ref}: rejected by ${verdict.rule}: ${verdict.message}`);
  }
  const failAll = (): void => {
    for (const u of updates) u.error ??= 'atomic push failed';
  };
  if (atomic && updates.some((u) => u.error)) failAll();

  // 4. changesets, parents first, only for updates still going ahead
  const failed = new Map<string, string>();
  for (const u of updates) {
    if (u.error) continue;
    for (const sha of u.commits) {
      if (push.csOf.has(sha) || failed.has(sha)) continue;
      try {
        push.csOf.set(sha, await storeCommit(push, sha, commits.get(sha) as PushCommit));
      } catch (err) {
        failed.set(sha, reason(err));
      }
    }
    const bad = u.commits.find((sha) => failed.has(sha));
    if (bad) u.error = failed.get(bad);
  }
  if (atomic && updates.some((u) => u.error)) failAll();

  // 5. one compare-and-swap per ref
  const moved: PushUpdate[] = [];
  for (const u of updates) {
    if (u.error) continue;
    const to = u.deleting ? null : (push.csOf.get(u.newSha) ?? null);
    try {
      await moveRefViaDO(env, repo.id, u.name, {
        from: u.from,
        to,
        non_ff: !u.fastForward,
        actor: principal,
        via: 'git-push',
      });
      moved.push(u);
    } catch (err) {
      u.error = reason(err);
      if (atomic) break;
    }
  }
  if (atomic && updates.some((u) => u.error)) {
    for (const u of moved.reverse()) {
      const to = u.deleting ? null : (push.csOf.get(u.newSha) as string);
      try {
        await moveRefViaDO(env, repo.id, u.name, {
          from: to,
          to: u.from,
          non_ff: true,
          skip_rulesets: true,
        });
      } catch (err) {
        console.error('receive-pack: atomic rollback failed', u.ref, err);
      }
    }
    moved.length = 0;
    failAll();
  }
  await recordAgentProvenance(
    env,
    repo.id,
    [
      ...new Set(
        moved.flatMap((u) => u.commits.flatMap((sha) => push.csOf.get(sha) ?? [])),
      ),
    ],
    principal,
  );
  for (const u of moved) {
    await recordAudit(c, {
      action: 'ref.move',
      repo,
      target: {
        ref: u.name,
        from: u.from,
        to: u.deleting ? null : (push.csOf.get(u.newSha) ?? null),
        force: !u.fastForward,
        via: 'git-push',
      },
    });
    if (u.pushRules) {
      await recordOutcome(env, u.pushRules, {
        repo,
        actor: actorOf(principal),
        ref: u.name,
        via: 'git-push',
      });
    }
  }
  // Commit messages landing on the default branch link and close issues (#38).
  for (const u of moved) {
    const to = push.csOf.get(u.newSha);
    if (u.name === repo.default_branch && !u.deleting && to)
      await linkLanded(c, repo, u.from, to);
  }

  // 6. push-triggered pipelines; CI reads the whole tree, as for API-started runs
  if (moved.length > 0 && ciReady(env)) {
    if (restrictingDecision(decider, ['read', 'write'])) {
      messages.push('CI: not started; pipelines need access to the whole repository');
    } else {
      try {
        messages.push(
          ...(await pushPipelines(
            env,
            repo.id,
            principal.userId,
            moved.map((u) => ({
              name: u.name,
              from: u.from,
              to: u.deleting ? null : (push.csOf.get(u.newSha) ?? null),
            })),
          )),
        );
      } catch (err) {
        // The refs already moved; a CI failure must not report the push as failed.
        console.error('receive-pack: pipeline trigger failed', err);
        messages.push('CI: pipelines could not be started; start them from the CI page');
      }
    }
  }
  return statusReport(updates, 'ok', useSideband, messages);
}

/** Create the changeset for one pushed commit and check it rebuilds to `sha`. */
async function storeCommit(push: Push, sha: string, commit: PushCommit): Promise<string> {
  const parsed = packCommit(push, sha) as ParsedCommit;
  const parents: string[] = [];
  for (const p of parsed.parents) {
    const id = push.csOf.get(p) ?? (await existingCommit(push, p));
    if (id === null) throw new PushError(`missing parent ${p} of ${sha}`);
    parents.push(id);
  }
  const changes: Change[] = [];
  for (const change of commit.changes) {
    if (change.op === 'del') {
      changes.push({ path: change.path, op: 'del' });
      continue;
    }
    changes.push({
      path: change.path,
      op: change.op,
      blob_sha256: await blobHash(push, change.sha as string),
      mode: change.mode as '100644' | '100755' | '120000',
    });
  }
  const { author, committer } = parsed;
  const result = await commitChanges(push.env, push.repoId, {
    first_parent: parents[0] ?? null,
    parents,
    message: parsed.message,
    author: { name: author.name, email: author.email },
    created_at: author.seconds * 1000,
    committer: {
      name: committer.name,
      email: committer.email,
      at: committer.seconds * 1000,
    },
    author_tz: author.tz,
    committer_tz: committer.tz,
    gpgsig: parsed.gpgsig,
    git_extra_headers: parsed.extraHeaders.length > 0 ? parsed.extraHeaders : undefined,
    changes,
  });
  const id = result.changeset.id;
  const stored = (await commitShas(push.env, push.repoId, [id])).get(id);
  if (stored !== sha) {
    throw new PushError(`commit ${sha} cannot be stored without changing its SHA`);
  }
  return id;
}

/** Our content address for a blob the push names: stored now or already present. */
async function blobHash(push: Push, sha: string): Promise<string> {
  const object = push.objects.get(sha);
  if (object) {
    if (object.type !== 'blob') throw new PushError(`${sha} is not a blob`);
    return (await putBlob(push.env, push.repoId, object.body)).hash;
  }
  const ref = await resolveSha1(push.env, push.repoId, sha);
  if (
    ref?.type === 'blob' &&
    (await hasBlob(push.env, push.repoId, [ref.id])).has(ref.id)
  ) {
    return ref.id;
  }
  throw new PushError(`missing blob ${sha}`);
}
