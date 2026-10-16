import type { Author, FileChange, GitCommitMeta } from '../../src/db/client';

/**
 * A small history that exercises every part of the Git mapping (issue #30):
 * nested dirs, Git sort order (`a-b` < `a.b` < `a/`, UTF-8 bytes not UTF-16),
 * executable and symlink modes, an agent author, time zones, a separate
 * committer, a merge and an empty commit.
 *
 * Shared by the worker test (stored IDs) and the CLI Git smoke (real
 * `git fast-import` + `git rev-parse HEAD`), which both check
 * `GIT_HISTORY_HEAD_SHA1`.
 */

export interface FixtureFile {
  content: string;
  mode?: string;
}

export interface FixtureCommit extends GitCommitMeta {
  key: string;
  parents: string[];
  author: Author;
  created_at: number;
  message: string;
  files: Record<string, FixtureFile>;
}

const base: Record<string, FixtureFile> = {
  'README.md': { content: 'hello from yag\n' },
  'bin/run.sh': { content: '#!/bin/sh\necho hi\n', mode: '100755' },
  link: { content: 'README.md', mode: '120000' },
  'src/a.ts': { content: 'export const a = 1;\n' },
  'a/x.txt': { content: 'dir a\n' },
  'a-b': { content: 'dash\n' },
  'a.b': { content: 'dot\n' },
  'ünï.txt': { content: 'utf-8\n' },
  'ｗ.txt': { content: 'fullwidth\n' },
  '😀.txt': { content: 'astral\n' },
};

const c2Files = { ...base, 'src/a.ts': { content: 'export const a = 2;\n' } };
const c3Files = {
  ...base,
  'docs/guide.md': { content: 'guide\n' },
  'bin/run.sh': { content: '#!/bin/sh\necho side\n', mode: '100755' },
};
const mergedFiles = {
  ...c2Files,
  'docs/guide.md': c3Files['docs/guide.md'],
  'bin/run.sh': c3Files['bin/run.sh'],
};

export const GIT_HISTORY: FixtureCommit[] = [
  {
    key: 'c1',
    parents: [],
    author: { name: 'Ada', email: 'ada@example.com' },
    created_at: 1_700_000_000_000,
    author_tz: '+1000',
    committer_tz: '+1000',
    message: 'root\n',
    files: base,
  },
  {
    key: 'c2',
    parents: ['c1'],
    author: { agent: 'agent-7' },
    created_at: 1_700_000_100_000,
    message: 'agent edit',
    files: c2Files,
  },
  {
    key: 'c3',
    parents: ['c1'],
    author: { name: 'Bob', email: 'bob@example.com' },
    created_at: 1_700_000_200_000,
    committer: { name: 'Carol', email: 'carol@example.com', at: 1_700_000_300_000 },
    committer_tz: '-0130',
    message: 'side branch\n\nwith a body\n',
    files: c3Files,
  },
  {
    key: 'c4',
    parents: ['c2', 'c3'],
    author: { name: 'Ada', email: 'ada@example.com' },
    created_at: 1_700_000_400_000,
    message: 'merge side\n',
    files: mergedFiles,
  },
  {
    key: 'c5',
    parents: ['c4'],
    author: { name: 'Ada', email: 'ada@example.com' },
    created_at: 1_700_000_500_000,
    message: 'empty\n',
    files: mergedFiles,
  },
];

/** `git rev-parse HEAD` after `git fast-import` of the full-mode stream. */
export const GIT_HISTORY_HEAD_SHA1 = '58c5b438bce151fe9235c85530ae589569e1114c';

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** `changed_files` of `files` relative to the first parent's files, sorted by path. */
export async function changedFiles(
  parent: Record<string, FixtureFile> | null,
  files: Record<string, FixtureFile>,
): Promise<FileChange[]> {
  const enc = new TextEncoder();
  const out: FileChange[] = [];
  const paths = new Set([...Object.keys(parent ?? {}), ...Object.keys(files)]);
  for (const path of [...paths].sort()) {
    const before = parent?.[path];
    const after = files[path];
    if (!after) {
      out.push({ path, op: 'del' });
      continue;
    }
    if (before?.content === after.content && before.mode === after.mode) continue;
    const bytes = enc.encode(after.content);
    out.push({
      path,
      op: before ? 'mod' : 'add',
      hash: await sha256Hex(bytes),
      size: bytes.byteLength,
    });
  }
  return out;
}
