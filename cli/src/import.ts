import { z } from 'zod';
import type { RequestBody } from '@yuma/agent-git-sdk';

/**
 * `yag import github` (issue #72): start an org bulk import from GitHub and
 * follow its per-repo report (`/api/v1/orgs/:org/imports`). The server does
 * the work; the CLI only starts, polls, resumes and prints.
 */

type StartBody = RequestBody<'startOrgImport'>;

const repoReport = z.object({
  github: z.string(),
  repo: z.string().nullable(),
  status: z.string(),
  phase: z.string(),
  counts: z.record(z.string(), z.number()),
  warnings: z.array(z.record(z.string(), z.unknown())),
  error: z.string().nullable(),
});
const importSchema = z.object({
  id: z.string(),
  status: z.string(),
  resume_at: z.number().nullable(),
  error: z.string().nullable(),
  repos: z.array(repoReport).optional(),
});
export type ImportReport = z.infer<typeof importSchema>;

export interface ImportClient {
  api: string;
  token?: string;
  fetch?: typeof fetch;
}

async function request(
  client: ImportClient,
  method: string,
  path: string,
  body?: unknown,
): Promise<ImportReport> {
  const res = await (client.fetch ?? fetch)(`${client.api.replace(/\/$/, '')}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(client.token ? { authorization: `Bearer ${client.token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => null)) as {
    import?: unknown;
    error?: { code: string; message: string };
  } | null;
  if (!res.ok) {
    const error = payload?.error;
    throw new Error(error ? `${error.code}: ${error.message}` : `HTTP ${res.status}`);
  }
  return importSchema.parse(payload?.import);
}

const orgPath = (org: string): string =>
  `/api/v1/orgs/${encodeURIComponent(org)}/imports`;

export function startImport(
  client: ImportClient,
  org: string,
  body: StartBody,
): Promise<ImportReport> {
  return request(client, 'POST', orgPath(org), body);
}

export function importStatus(
  client: ImportClient,
  org: string,
  id: string,
): Promise<ImportReport> {
  return request(client, 'GET', `${orgPath(org)}/${encodeURIComponent(id)}`);
}

export function resumeImport(
  client: ImportClient,
  org: string,
  id: string,
): Promise<ImportReport> {
  return request(client, 'POST', `${orgPath(org)}/${encodeURIComponent(id)}/resume`);
}

const FINISHED = new Set(['done', 'partial', 'failed']);

/** Poll until the job finishes (rate-limit pauses included). */
export async function waitForImport(
  client: ImportClient,
  org: string,
  id: string,
  opts: { intervalMs?: number; onProgress?: (report: ImportReport) => void } = {},
): Promise<ImportReport> {
  for (;;) {
    const report = await importStatus(client, org, id);
    opts.onProgress?.(report);
    if (FINISHED.has(report.status)) return report;
    await new Promise((resolve) => setTimeout(resolve, opts.intervalMs ?? 5000));
  }
}

/** One line for the job, then one per repo with its counts and any error. */
export function formatReport(report: ImportReport): string[] {
  const head = `import ${report.id}: ${report.status}${
    report.status === 'rate_limited' && report.resume_at
      ? ` until ${new Date(report.resume_at).toISOString()}`
      : ''
  }${report.error ? ` (${report.error})` : ''}`;
  const lines = [head];
  for (const repo of report.repos ?? []) {
    const counts = Object.entries(repo.counts)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    lines.push(
      `  ${repo.github} -> ${repo.repo ?? '(not created)'} ${repo.status} [${repo.phase}]${
        counts ? ` ${counts}` : ''
      }${repo.warnings.length ? ` warnings=${repo.warnings.length}` : ''}${
        repo.error ? ` error: ${repo.error}` : ''
      }`,
    );
  }
  return lines;
}
