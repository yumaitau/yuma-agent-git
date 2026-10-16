import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { deflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fastImportChunks } from '../../worker/src/bridge/fastimport';
import { hashTree } from '../../worker/src/core/trees';
import { canonicalJson } from '../../worker/src/core/hashing';
import { createHash } from 'node:crypto';
import type { Changeset } from '../../worker/src/core/changesets';
import type { TreeEntry } from '../../worker/src/core/trees';
import { gitCommitFor } from '../../worker/src/git/mapping';
import {
  EMPTY_TREE,
  TREE_MODE,
  gitBlobId,
  gitCommitId,
  gitTreeId,
  type GitIds,
  type GitTreeEntry,
} from '../../worker/src/git/objects';
import {
  GIT_HISTORY,
  GIT_HISTORY_HEAD_SHA1,
  changedFiles,
  type FixtureFile,
} from '../../worker/test/fixtures/git-history';

/**
 * Real-git smoke (issue #16): pipe a generated fast-import stream into
 * `git init` + `git fast-import` and read the result back with `git show`.
 * This is THE contract test that we emit valid git — it needs process exec,
 * so it lives in the node-side workspace and runs in CI (or with
 * YAG_GIT_SMOKE=1) where git is available.
 */

const hasGit = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const enabled = (process.env.CI || process.env.YAG_GIT_SMOKE) && hasGit;

// ---------------------------------------------------------------------------
// Minimal in-memory env: just what fastimport touches (D1 changesets + R2)
// ---------------------------------------------------------------------------

interface FakeRow {
  [key: string]: unknown;
}

function fakeEnv(
  trees: Map<string, unknown>,
  blobs: Map<string, Uint8Array>,
  changesets: FakeRow[],
) {
  return {
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first() {
                if (/FROM changesets/i.test(sql)) {
                  return changesets.find((r) => r.id === args[1]) ?? null;
                }
                return null;
              },
              async all() {
                if (/FROM changesets/i.test(sql)) {
                  return {
                    results: [...changesets]
                      .reverse()
                      .filter((r) => args[0] === undefined || r.repo_id === args[0]),
                  };
                }
                return { results: [] };
              },
              async run() {
                return { meta: {} };
              },
            };
          },
        };
      },
      async batch() {
        return [];
      },
    },
    OBJECTS: {
      async get(key: string) {
        // the real store compresses with the preferred codec (deflate-raw today)
        const treeMatch = /trees\/..\/(.+)$/.exec(key);
        if (treeMatch) {
          const payload = trees.get(treeMatch[1] as string);
          return payload
            ? {
                customMetadata: { encoding: 'deflate-raw' },
                // the store holds canonical JSON — that IS the hash input
                arrayBuffer: async () =>
                  deflateRawSync(
                    new TextEncoder().encode(
                      canonicalJson({
                        entries: (payload as { entries: unknown[] }).entries,
                      }),
                    ),
                  ).buffer as ArrayBuffer,
              }
            : null;
        }
        const blobMatch = /blobs\/..\/(.+)$/.exec(key);
        if (blobMatch) {
          const content = blobs.get(blobMatch[1] as string);
          return content
            ? {
                customMetadata: { encoding: 'deflate-raw' },
                arrayBuffer: async () => deflateRawSync(content).buffer as ArrayBuffer,
              }
            : null;
        }
        return null;
      },
    },
  } as never;
}

describe('fast-import → real git (CI smoke)', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'yag-git-smoke-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.runIf(enabled)(
    'git fast-import accepts our snapshot stream and git show matches content',
    async () => {
      const enc = new TextEncoder();
      const content = enc.encode('hello from yag\n');
      // real content addresses — getTree/getBlob verify every hash
      const hash = createHash('sha256').update(content).digest('hex');
      const tree = {
        entries: [
          {
            name: 'README.md',
            kind: 'blob' as const,
            hash,
            size: content.byteLength,
            mode: '100644',
          },
        ],
      };
      const treeHash = await hashTree(tree);
      const blobs = new Map([[hash, content]]);
      const trees = new Map<string, unknown>([[treeHash, tree]]);
      const env = fakeEnv(trees, blobs, [
        {
          id: 'c'.repeat(64),
          repo_id: 'repo',
          first_parent: null,
          parents: '[]',
          author: JSON.stringify({ name: 'Ada', email: 'ada@example.com' }),
          message: 'snapshot',
          created_at: 1_700_000_000_000,
          changed_files: JSON.stringify([
            { path: 'README.md', op: 'add', hash, size: content.byteLength },
          ]),
          root_tree: treeHash,
        },
      ]);

      const stream = fastImportChunks(env, 'repo', 'c'.repeat(64), { mode: 'snapshot' });
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream) chunks.push(chunk);

      // The export targets main; never depend on the host's init.defaultBranch.
      const init = spawnSync('git', ['init', '-q', '--initial-branch=main'], {
        cwd: dir,
      });
      expect(init.status).toBe(0);
      const importRun = spawnSync('git', ['fast-import', '--quiet'], {
        cwd: dir,
        input: Buffer.concat(chunks.map((c) => Buffer.from(c))),
      });
      expect(importRun.status).toBe(0);

      const show = spawnSync('git', ['show', 'HEAD:README.md'], {
        cwd: dir,
        encoding: 'utf8',
      });
      expect(show.status, show.stderr).toBe(0);
      expect(show.stdout).toBe('hello from yag\n');
    },
    60_000,
  );

  it('is skipped without git or CI', () => {
    if (!enabled) {
      expect(hasGit && !!process.env.CI).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Git object mapping (issue #30)
// ---------------------------------------------------------------------------

function git(cwd: string, args: string[], input?: string | Buffer): string {
  const res = spawnSync('git', args, { cwd, input, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

/**
 * Store a file map as our trees + blobs and, independently, compute its Git
 * IDs with the pure encoders (the model real git is checked against).
 */
async function buildTree(
  files: Record<string, FixtureFile>,
  trees: Map<string, unknown>,
  blobs: Map<string, Uint8Array>,
): Promise<{ hash: string; git: GitIds }> {
  const dirs = new Map<string, Record<string, FixtureFile>>();
  const entries: TreeEntry[] = [];
  const gitEntries: GitTreeEntry[] = [];
  for (const [path, file] of Object.entries(files)) {
    const slash = path.indexOf('/');
    if (slash >= 0) {
      const dir = path.slice(0, slash);
      dirs.set(dir, { ...(dirs.get(dir) ?? {}), [path.slice(slash + 1)]: file });
      continue;
    }
    const bytes = new TextEncoder().encode(file.content);
    const hash = createHash('sha256').update(bytes).digest('hex');
    blobs.set(hash, bytes);
    const mode = file.mode ?? '100644';
    entries.push({ name: path, kind: 'blob', hash, size: bytes.byteLength, mode });
    gitEntries.push({ name: path, mode, ids: await gitBlobId(bytes) });
  }
  for (const [name, sub] of dirs) {
    const child = await buildTree(sub, trees, blobs);
    entries.push({ name, kind: 'tree', hash: child.hash });
    gitEntries.push({ name, mode: TREE_MODE, ids: child.git });
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const hash = await hashTree({ entries });
  trees.set(hash, { entries });
  return { hash, git: await gitTreeId(gitEntries) };
}

/** Fixture history as fake changeset rows, plus the expected Git IDs per commit. */
async function historyEnv() {
  const trees = new Map<string, unknown>();
  const blobs = new Map<string, Uint8Array>();
  const rows: FakeRow[] = [];
  const expected = new Map<string, GitIds>();
  const filesOf = new Map<string, Record<string, FixtureFile>>();
  for (const commit of GIT_HISTORY) {
    const tree = await buildTree(commit.files, trees, blobs);
    const first = commit.parents[0];
    const cs: Changeset = {
      id: commit.key,
      repo_id: 'repo',
      first_parent: first ?? null,
      parents: commit.parents,
      author: commit.author,
      message: commit.message,
      created_at: commit.created_at,
      changed_files: await changedFiles(
        first ? (filesOf.get(first) ?? null) : null,
        commit.files,
      ),
      root_tree: tree.hash,
      ...(commit.committer ? { committer: commit.committer } : {}),
      ...(commit.author_tz ? { author_tz: commit.author_tz } : {}),
      ...(commit.committer_tz ? { committer_tz: commit.committer_tz } : {}),
    };
    filesOf.set(commit.key, commit.files);
    expected.set(
      commit.key,
      await gitCommitId(
        gitCommitFor(
          cs,
          tree.git,
          commit.parents.map((p) => expected.get(p) as GitIds),
        ),
      ),
    );
    rows.push({
      ...cs,
      parents: JSON.stringify(cs.parents),
      author: JSON.stringify(cs.author),
      changed_files: JSON.stringify(cs.changed_files),
      committer: cs.committer ? JSON.stringify(cs.committer) : null,
    });
  }
  return { env: fakeEnv(trees, blobs, rows), expected };
}

describe('git object mapping → real git (CI smoke, issue #30)', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'yag-git-ids-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.runIf(enabled)(
    'git fast-import of the full stream rebuilds every commit ID (SHA-1 and SHA-256)',
    async () => {
      const { env, expected } = await historyEnv();
      const head = GIT_HISTORY[GIT_HISTORY.length - 1]?.key as string;
      const chunks: Uint8Array[] = [];
      for await (const chunk of fastImportChunks(env, 'repo', head, { mode: 'full' })) {
        chunks.push(chunk);
      }
      const stream = Buffer.concat(chunks.map((c) => Buffer.from(c)));

      for (const format of ['sha1', 'sha256'] as const) {
        const repo = join(dir, format);
        git(dir, [
          'init',
          '-q',
          '--initial-branch=main',
          `--object-format=${format}`,
          repo,
        ]);
        git(repo, ['fast-import', '--quiet'], stream);
        expect(git(repo, ['rev-parse', 'HEAD'])).toBe(expected.get(head)?.[format]);
        // every commit, merge parents included, has the expected ID
        const all = git(repo, ['rev-list', '--all']).split('\n').sort();
        expect(all).toEqual([...expected.values()].map((ids) => ids[format]).sort());
        git(repo, ['fsck', '--strict', '--no-progress']);
      }
      // the same value the worker test reads back from git_commits.sha1
      expect(expected.get(head)?.sha1).toBe(GIT_HISTORY_HEAD_SHA1);
    },
    60_000,
  );

  const hasSshKeygen =
    spawnSync('ssh-keygen', ['-?'], { encoding: 'utf8' }).error === undefined;

  it.runIf(enabled && hasSshKeygen)(
    'a signed commit with an encoding header round-trips byte for byte',
    async () => {
      const repo = join(dir, 'signed');
      git(dir, ['init', '-q', repo]);
      const key = join(dir, 'signing-key');
      const keygen = spawnSync('ssh-keygen', [
        '-q',
        '-t',
        'ed25519',
        '-N',
        '',
        '-f',
        key,
      ]);
      expect(keygen.status).toBe(0);
      const tree = git(repo, ['hash-object', '-t', 'tree', '-w', '--stdin'], '');
      const res = spawnSync(
        'git',
        [
          '-c',
          'gpg.format=ssh',
          '-c',
          `user.signingkey=${key}`,
          '-c',
          'i18n.commitEncoding=ISO-8859-1',
          'commit-tree',
          '-S',
          tree,
          '-m',
          'signed',
        ],
        {
          cwd: repo,
          encoding: 'utf8',
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'Ada',
            GIT_AUTHOR_EMAIL: 'ada@example.com',
            GIT_AUTHOR_DATE: '1700000000 +1000',
            GIT_COMMITTER_NAME: 'Carol',
            GIT_COMMITTER_EMAIL: 'carol@example.com',
            GIT_COMMITTER_DATE: '1700000300 -0130',
          },
        },
      );
      expect(res.status, res.stderr).toBe(0);
      const id = res.stdout.trim();

      // parse git's own bytes into our model, then re-encode
      const raw = git(repo, ['cat-file', 'commit', id]);
      const split = raw.indexOf('\n\n');
      const headers: [string, string][] = [];
      for (const lineText of raw.slice(0, split).split('\n')) {
        if (lineText.startsWith(' ')) {
          const last = headers[headers.length - 1] as [string, string];
          last[1] += `\n${lineText.slice(1)}`;
        } else {
          const space = lineText.indexOf(' ');
          headers.push([lineText.slice(0, space), lineText.slice(space + 1)]);
        }
      }
      const value = (key: string): string => headers.find(([k]) => k === key)?.[1] ?? '';
      const signature = (ident: string) => {
        const m = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(ident) as RegExpExecArray;
        return {
          name: m[1] as string,
          email: m[2] as string,
          seconds: Number(m[3]),
          tz: m[4] as string,
        };
      };
      // `git()` trims, so the message's final newline comes back here
      const ids = await gitCommitId({
        tree: EMPTY_TREE,
        parents: [],
        author: signature(value('author')),
        committer: signature(value('committer')),
        extraHeaders: [['encoding', value('encoding')]],
        gpgsig: value('gpgsig'),
        message: `${raw.slice(split + 2)}\n`,
      });
      expect(value('encoding')).toBe('ISO-8859-1');
      expect(value('gpgsig')).toContain('BEGIN SSH SIGNATURE');
      expect(ids.sha1).toBe(id);
    },
    60_000,
  );

  it.runIf(enabled)(
    'random trees agree with git hash-object and git mktree (SHA-1 and SHA-256)',
    async () => {
      // deterministic PRNG (mulberry32) so a failure reproduces
      let seed = 30;
      const rand = (): number => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const pick = <T>(items: readonly T[]): T =>
        items[Math.floor(rand() * items.length)] as T;
      const parts = ['a', 'b', 'a-b', 'a.b', 'a_b', 'A', 'z', 'ü', 'ｗ', '😀', '0', '.x'];
      const modes = ['100644', '100755', '120000'] as const;
      const formats = ['sha1', 'sha256'] as const;
      const repos = { sha1: join(dir, 'prop-sha1'), sha256: join(dir, 'prop-sha256') };
      for (const format of formats) {
        git(dir, ['init', '-q', `--object-format=${format}`, repos[format]]);
        expect(git(repos[format], ['hash-object', '-t', 'tree', '--stdin'], '')).toBe(
          EMPTY_TREE[format],
        );
      }

      /** Random tree written to both repos; returns the model IDs. */
      const randomTree = async (depth: number): Promise<GitIds> => {
        const entries = new Map<string, GitTreeEntry>();
        const count = 1 + Math.floor(rand() * 6);
        for (let i = 0; i < count; i++) {
          const name = `${pick(parts)}${rand() < 0.3 ? pick(parts) : ''}`;
          if (entries.has(name)) continue;
          if (depth > 0 && rand() < 0.3) {
            entries.set(name, {
              name,
              mode: TREE_MODE,
              ids: await randomTree(depth - 1),
            });
            continue;
          }
          const content = `${name} ${Math.floor(rand() * 1e9)}\n`.repeat(
            Math.floor(rand() * 3),
          );
          const ids = await gitBlobId(new TextEncoder().encode(content));
          for (const format of formats) {
            expect(git(repos[format], ['hash-object', '-w', '--stdin'], content)).toBe(
              ids[format],
            );
          }
          entries.set(name, { name, mode: pick(modes), ids });
        }
        const ids = await gitTreeId([...entries.values()]);
        for (const format of formats) {
          const input = [...entries.values()]
            .map(
              (e) =>
                `${e.mode === TREE_MODE ? '040000 tree' : `${e.mode} blob`} ${e.ids[format]}\t${e.name}\n`,
            )
            .join('');
          expect(git(repos[format], ['mktree'], input)).toBe(ids[format]);
        }
        return ids;
      };

      for (let i = 0; i < 30; i++) await randomTree(2);
    },
    120_000,
  );
});
