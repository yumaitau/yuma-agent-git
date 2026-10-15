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
      const init = spawnSync('git', ['init', '-q', '--initial-branch=main'], { cwd: dir });
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
