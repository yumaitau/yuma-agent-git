import { z } from 'zod';
import type { Env } from '../env';
import { q, q1, run } from '../db/client';
import { ApiError } from '../core/errors';
import { getChangeset } from '../core/changesets';
import { sha256Hex } from '../core/hashing';
import { ulid } from '../core/ids';
import { scanText, redactSecrets } from '../security/secrets/detectors';

/**
 * Agent sessions (issue #58): who ran, with which model, harness and tools,
 * linked to the changesets they produced. A transcript is redacted with the
 * secret scanning detectors (#66) before it is stored in R2 at
 * `sessions/<repo_id>/<id>.jsonl`; provenance statements carry only its
 * SHA-256, and only repo writers can read it back.
 */

export const MAX_TRANSCRIPT_BYTES = 5 * 1024 * 1024;
export const MAX_LINKS = 100;

const csId = z.string().regex(/^[0-9a-f]{64}$/, 'a changeset id');

export const createSessionSchema = z.object({
  task_id: z.string().min(1).max(200).optional(),
  model: z.string().min(1).max(200).optional(),
  harness: z.string().min(1).max(200).optional(),
  tools: z.array(z.string().min(1).max(100)).max(200).default([]),
  started_at: z.number().int().positive(),
  ended_at: z.number().int().positive().optional(),
  /** JSON lines; secrets are redacted before storage. */
  transcript: z.string().max(MAX_TRANSCRIPT_BYTES).optional(),
  changesets: z.array(csId).max(MAX_LINKS).default([]),
});
export type CreateSession = z.infer<typeof createSessionSchema>;

export const linkSessionSchema = z.object({
  changesets: z.array(csId).min(1).max(MAX_LINKS),
});

export interface SessionRow {
  id: string;
  repo_id: string;
  agent_id: string | null;
  on_behalf_of: string;
  task_id: string | null;
  model: string | null;
  harness: string | null;
  tools: string;
  transcript_key: string | null;
  transcript_sha256: string | null;
  transcript_size: number | null;
  redactions: number;
  started_at: number;
  ended_at: number | null;
  created_by: string;
  created_at: number;
}

export interface SessionView {
  id: string;
  agent_id: string | null;
  on_behalf_of: string;
  task_id: string | null;
  model: string | null;
  harness: string | null;
  tools: string[];
  transcript: { sha256: string; size: number; redactions: number } | null;
  started_at: number;
  ended_at: number | null;
  created_by: string;
  created_at: number;
}

export function sessionView(row: SessionRow): SessionView {
  return {
    id: row.id,
    agent_id: row.agent_id,
    on_behalf_of: row.on_behalf_of,
    task_id: row.task_id,
    model: row.model,
    harness: row.harness,
    tools: JSON.parse(row.tools) as string[],
    transcript:
      row.transcript_sha256 === null
        ? null
        : {
            sha256: row.transcript_sha256,
            size: row.transcript_size ?? 0,
            redactions: row.redactions,
          },
    started_at: row.started_at,
    ended_at: row.ended_at,
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

export function transcriptKey(repoId: string, id: string): string {
  return `sessions/${repoId}/${id}.jsonl`;
}

/** Link changesets of `repoId` to a session; unknown changesets are refused. */
export async function linkChangesets(
  env: Env,
  repoId: string,
  sessionId: string,
  ids: readonly string[],
): Promise<void> {
  const unique = [...new Set(ids)];
  for (const id of unique)
    if (!(await getChangeset(env, repoId, id)))
      throw new ApiError(404, 'changeset_not_found', `No changeset ${id}`);
  if (unique.length === 0) return;
  const now = Date.now();
  await env.DB.batch(
    unique.map((id) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO changeset_sessions (repo_id, cs_id, session_id, created_at)
         VALUES (?, ?, ?, ?)`,
      ).bind(repoId, id, sessionId, now),
    ),
  );
}

export async function createSession(
  env: Env,
  input: CreateSession & {
    repo_id: string;
    agent_id: string | null;
    on_behalf_of: string;
    created_by: string;
  },
): Promise<SessionRow> {
  const now = Date.now();
  const id = ulid(now);
  let transcript: { key: string; sha256: string; size: number; redactions: number } | null =
    null;
  if (input.transcript !== undefined) {
    const redactions = scanText(input.transcript).length;
    const bytes = new TextEncoder().encode(
      redactions === 0 ? input.transcript : redactSecrets(input.transcript),
    );
    const key = transcriptKey(input.repo_id, id);
    await env.OBJECTS.put(key, bytes, {
      httpMetadata: { contentType: 'application/jsonl' },
    });
    transcript = { key, sha256: await sha256Hex(bytes), size: bytes.length, redactions };
  }
  const row: SessionRow = {
    id,
    repo_id: input.repo_id,
    agent_id: input.agent_id,
    on_behalf_of: input.on_behalf_of,
    task_id: input.task_id ?? null,
    model: input.model ?? null,
    harness: input.harness ?? null,
    tools: JSON.stringify([...new Set(input.tools)]),
    transcript_key: transcript?.key ?? null,
    transcript_sha256: transcript?.sha256 ?? null,
    transcript_size: transcript?.size ?? null,
    redactions: transcript?.redactions ?? 0,
    started_at: input.started_at,
    ended_at: input.ended_at ?? null,
    created_by: input.created_by,
    created_at: now,
  };
  try {
    await linkChangesets(env, input.repo_id, id, input.changesets);
    await run(
      env,
      `INSERT INTO agent_sessions (id, repo_id, agent_id, on_behalf_of, task_id, model, harness,
         tools, transcript_key, transcript_sha256, transcript_size, redactions, started_at,
         ended_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.repo_id,
        row.agent_id,
        row.on_behalf_of,
        row.task_id,
        row.model,
        row.harness,
        row.tools,
        row.transcript_key,
        row.transcript_sha256,
        row.transcript_size,
        row.redactions,
        row.started_at,
        row.ended_at,
        row.created_by,
        row.created_at,
      ],
    );
  } catch (err) {
    if (transcript) await env.OBJECTS.delete(transcript.key);
    await run(env, 'DELETE FROM changeset_sessions WHERE session_id = ?', [id]);
    throw err;
  }
  return row;
}

export async function getSession(
  env: Env,
  repoId: string,
  id: string,
): Promise<SessionRow | null> {
  return q1<SessionRow>(env, 'SELECT * FROM agent_sessions WHERE repo_id = ? AND id = ?', [
    repoId,
    id,
  ]);
}

/** Sessions linked to one changeset, oldest first. */
export async function sessionsFor(
  env: Env,
  repoId: string,
  csId: string,
): Promise<SessionRow[]> {
  return q<SessionRow>(
    env,
    `SELECT s.* FROM changeset_sessions l JOIN agent_sessions s ON s.id = l.session_id
      WHERE l.repo_id = ? AND l.cs_id = ? ORDER BY s.id LIMIT 50`,
    [repoId, csId],
  );
}
