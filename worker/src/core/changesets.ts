import { z } from 'zod';
import type { Env } from '../env';
import {
  authorSchema,
  fileChangeSchema,
  parseChangesetRow,
  q1,
  run,
  type Author,
  type FileChange,
} from '../db/client';
import { C, T } from '../db/schema';
import { RequestValidationError } from './errors';
import { canonicalJson, sha256Hex } from './hashing';

export type { Author, FileChange };

/**
 * A changeset — the unit of work (architecture §1.3). Like a git commit, but
 * instead of a tree pointer it stores the files changed relative to its first
 * parent, with content-addressed hashes. Immutable and content-addressed.
 *
 * For merge commits (`parents.length > 1`) `changed_files` is relative to the
 * **first parent** (Scion footnote 1) — mainline history is what blame and
 * merge semantics care about.
 */
export interface Changeset {
  id: string;
  repo_id: string;
  first_parent: string | null;
  parents: string[];
  author: Author;
  message: string;
  created_at: number;
  changed_files: FileChange[];
  root_tree: string | null;
}

/** Fields hashed into the changeset id. */
export interface ChangesetFields {
  repo_id: string;
  first_parent: string | null;
  parents: string[];
  author: Author;
  message: string;
  changed_files: FileChange[];
}

export interface CreateChangesetInput extends Omit<ChangesetFields, 'repo_id'> {
  /** Server-set when omitted (epoch ms). */
  created_at?: number;
  root_tree?: string | null;
}

const DOMAIN_TAG = 'yag-changeset-v1';

/** Paths: no leading `/`, no `.`/`..` segments, no empty segments, NFC. */
export const pathSchema = z.string().transform((value, ctx): string => {
  const path = value.normalize('NFC');
  const fail = (message: string): never => {
    ctx.addIssue({ code: 'custom', message });
    return z.NEVER;
  };
  if (path === '') return fail('path must not be empty');
  if (path.startsWith('/')) return fail('path must not start with "/"');
  if (path.endsWith('/')) return fail('path must not end with "/"');
  const segments = path.split('/');
  if (segments.some((s) => s === '')) return fail('path must not contain "//"');
  if (segments.some((s) => s === '.' || s === '..')) {
    return fail('path must not contain "." or ".." segments');
  }
  return path;
});

const fileChangeInputSchema = fileChangeSchema.extend({ path: pathSchema });

const changesetInputSchema = z.object({
  repo_id: z.string().min(1),
  first_parent: z.string().min(1).nullable(),
  parents: z.array(z.string().min(1)),
  author: authorSchema,
  message: z.string().min(1).max(65536),
  changed_files: z.array(fileChangeInputSchema).max(5000),
  created_at: z.number().int().optional(),
  root_tree: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable()
    .optional(),
});

/**
 * Changeset id = SHA-256 of canonical JSON over the semantic fields, with a
 * domain tag. `created_at` is deliberately excluded: timestamps are server
 * metadata, and excluding them makes identical commits content-addressed →
 * idempotent (architecture §1.3).
 */
export function computeChangesetId(fields: ChangesetFields): Promise<string> {
  return sha256Hex(
    new TextEncoder().encode(
      canonicalJson({
        domain: DOMAIN_TAG,
        repo_id: fields.repo_id,
        first_parent: fields.first_parent,
        parents: fields.parents,
        author: fields.author,
        message: fields.message,
        changed_files: fields.changed_files,
      }),
    ),
  );
}

/**
 * Validate + insert a changeset. Idempotent: a UNIQUE hit on the id (same
 * content) returns the existing row instead of failing.
 */
export async function createChangeset(
  env: Env,
  repoId: string,
  input: CreateChangesetInput,
): Promise<Changeset> {
  const parsed = changesetInputSchema.safeParse({ ...input, repo_id: repoId });
  if (!parsed.success) {
    throw new RequestValidationError('invalid changeset', {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
  }
  const fields = parsed.data;

  // Parent structure: root (first_parent null ⇔ parents []) or parents[0] === first_parent.
  if (fields.first_parent === null) {
    if (fields.parents.length !== 0) {
      throw new RequestValidationError(
        'root changeset must have no parents',
        { parents: fields.parents },
        'invalid_parents',
      );
    }
  } else if (fields.parents.length === 0 || fields.parents[0] !== fields.first_parent) {
    throw new RequestValidationError(
      'parents must start with first_parent',
      { first_parent: fields.first_parent, parents: fields.parents },
      'invalid_parents',
    );
  }
  for (const parentId of fields.parents) {
    const parent = await q1(
      env,
      `SELECT ${C.changesets.id} FROM ${T.changesets} WHERE ${C.changesets.repoId} = ? AND ${C.changesets.id} = ?`,
      [repoId, parentId],
    );
    if (!parent) {
      throw new RequestValidationError(
        `unknown parent changeset: ${parentId}`,
        { parent: parentId },
        'unknown_parent',
      );
    }
  }

  const id = await computeChangesetId(fields);
  const existing = await getChangeset(env, repoId, id);
  if (existing) return existing;

  const changeset: Changeset = {
    id,
    repo_id: fields.repo_id,
    first_parent: fields.first_parent,
    parents: fields.parents,
    author: fields.author,
    message: fields.message,
    created_at: fields.created_at ?? Date.now(),
    changed_files: fields.changed_files,
    root_tree: fields.root_tree ?? null,
  };

  await run(
    env,
    `INSERT OR IGNORE INTO ${T.changesets}
       (${C.changesets.id}, ${C.changesets.repoId}, ${C.changesets.firstParent},
        ${C.changesets.parents}, ${C.changesets.author}, ${C.changesets.message},
        ${C.changesets.createdAt}, ${C.changesets.changedFiles}, ${C.changesets.rootTree})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      changeset.id,
      changeset.repo_id,
      changeset.first_parent,
      JSON.stringify(changeset.parents),
      JSON.stringify(changeset.author),
      changeset.message,
      changeset.created_at,
      JSON.stringify(changeset.changed_files),
      changeset.root_tree,
    ],
  );

  // Re-read: INSERT OR IGNORE may have been a no-op under concurrency.
  return (await getChangeset(env, repoId, id)) ?? changeset;
}

/** Fetch one changeset by id. */
export async function getChangeset(
  env: Env,
  repoId: string,
  id: string,
): Promise<Changeset | null> {
  const row = await q1(
    env,
    `SELECT * FROM ${T.changesets} WHERE ${C.changesets.repoId} = ? AND ${C.changesets.id} = ?`,
    [repoId, id],
  );
  return row ? parseChangesetRow(row) : null;
}

/**
 * Walk first-parent history from `head`, newest first, up to `limit`.
 * Iterative, one indexed read per hop.
 */
export async function firstParentHistory(
  env: Env,
  repoId: string,
  head: string,
  limit: number,
): Promise<Changeset[]> {
  const out: Changeset[] = [];
  let cursor: string | null = head;
  while (cursor !== null && out.length < limit) {
    const cs: Changeset | null = await getChangeset(env, repoId, cursor);
    if (cs === null) break;
    out.push(cs);
    cursor = cs.first_parent;
  }
  return out;
}
