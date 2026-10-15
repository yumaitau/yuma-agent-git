import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ApiError, type YagApi } from './api.js';
import { loadState, saveState, type YagState } from './config.js';
import { sha256Hex } from './checkout.js';

const MAX_INLINE_BYTES = 4 * 1024 * 1024;

/** Every file in the working copy (minus `.yag` bookkeeping). */
export async function walkWorkingCopy(
  dir: string,
): Promise<Map<string, { mtimeMs: number }>> {
  const out = new Map<string, { mtimeMs: number }>();
  const walk = async (rel: string): Promise<void> => {
    const entries = await readdir(join(dir, rel), { withFileTypes: true });
    for (const entry of entries) {
      const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (relPath === '.yag') continue;
        await walk(relPath);
      } else if (entry.isFile() && !entry.name.endsWith('.yag-tmp')) {
        const st = await stat(join(dir, relPath));
        out.set(relPath, { mtimeMs: st.mtimeMs });
      }
    }
  };
  await walk('');
  return out;
}

export interface StatusResult {
  modified: string[];
  deleted: string[];
  untracked: string[];
}

/**
 * Compare the working copy against `.yag/state.json`: hash only files whose
 * mtime moved (the cheap path for clean trees).
 */
export async function status(dir: string, state?: YagState): Promise<StatusResult> {
  const st = state ?? (await loadState(dir));
  const disk = await walkWorkingCopy(dir);
  const known = new Map(st.entries.map((e) => [e.path, e]));
  const modified: string[] = [];
  const deleted: string[] = [];
  const untracked: string[] = [];

  for (const [path, entry] of known) {
    const onDisk = disk.get(path);
    if (!onDisk) {
      deleted.push(path);
      continue;
    }
    if (Math.floor(onDisk.mtimeMs) !== entry.mtime) {
      const bytes = await readFile(join(dir, path));
      if (sha256Hex(bytes) !== entry.blob_hash) modified.push(path);
    }
  }
  for (const path of disk.keys()) {
    if (!known.has(path)) untracked.push(path);
  }
  return {
    modified: modified.sort(),
    deleted: deleted.sort(),
    untracked: untracked.sort(),
  };
}

export interface CommitOutcome {
  id: string;
  ref?: string;
  refMoved: boolean;
  /** Set when the CAS ref move lost to a concurrent land — caller exits 3. */
  stale?: { expected: string | null; actual: string | null };
}

/**
 * Commit the working copy as one changeset against the checked-out revision.
 * Files ≤ 4 MiB travel inline; larger ones are pre-uploaded (hash-verified on
 * the server). `--ref` moves the ref with a compare-and-swap: a stale head
 * means someone else landed first. The saved local commit must be preserved
 * while its changes are replayed onto the latest branch head.
 */
export async function commit(opts: {
  dir: string;
  api: YagApi;
  message: string;
  author: { name: string; email: string };
  ref?: string;
}): Promise<CommitOutcome> {
  const state = await loadState(opts.dir);
  const st = await status(opts.dir, state);

  const changes: unknown[] = [];
  const entries = new Map(state.entries.map((entry) => [entry.path, entry]));
  for (const path of st.deleted) {
    changes.push({ path, op: 'del' });
    entries.delete(path);
  }
  const touched: Array<readonly [string, 'add' | 'mod']> = [
    ...st.untracked.map((p) => [p, 'add'] as const),
    ...st.modified.map((p) => [p, 'mod'] as const),
  ];
  for (const [path, op] of touched) {
    const bytes = await readFile(join(opts.dir, path));
    const hash = sha256Hex(bytes);
    // Save the uploaded snapshot, not a later disk read. Force a hash on the
    // next status so edits made during upload cannot be mistaken for clean files.
    entries.set(path, { path, blob_hash: hash, mtime: 0 });
    if (bytes.byteLength <= MAX_INLINE_BYTES) {
      changes.push({ path, op, content_b64: bytes.toString('base64') });
    } else {
      // pre-upload the blob (server verifies the content address on arrival)
      await opts.api.uploadBlob(hash, bytes);
      changes.push({ path, op, blob_sha256: hash });
    }
  }

  const result = await opts.api.createChangeset({
    first_parent: state.cs,
    message: opts.message,
    author: opts.author,
    changes,
  });

  if (!result.changeset.root_tree)
    throw new Error(
      `Created ${result.changeset.id}, but the server returned no source tree`,
    );
  await saveState(opts.dir, {
    ...state,
    cs: result.changeset.id,
    root_tree: result.changeset.root_tree,
    entries: [...entries.values()].sort((a, b) => a.path.localeCompare(b.path)),
  });

  if (!opts.ref) return { id: result.changeset.id, refMoved: false };

  try {
    await opts.api.moveRef(opts.ref, {
      from: state.cs,
      to: result.changeset.id,
    });
    return { id: result.changeset.id, ref: opts.ref, refMoved: true };
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      const details = (
        err.body as { error?: { expected?: string | null; actual?: string | null } }
      )?.error;
      return {
        id: result.changeset.id,
        ref: opts.ref,
        refMoved: false,
        stale: { expected: details?.expected ?? null, actual: details?.actual ?? null },
      };
    }
    throw err;
  }
}
