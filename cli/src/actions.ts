import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { RequestBody } from '@yuma/agent-git-sdk';

/**
 * `yag actions check` (issue #49): how each GitHub Actions workflow would run
 * on the forge. Local `.github/workflows` files go to the server's translator
 * (`POST /api/v1/ci/actions/check`), so the CLI never carries a second copy;
 * `--repo` reads the report for a repository's own files instead.
 */

type Files = RequestBody<'checkWorkflows'>['files'];
export const WORKFLOW_DIR = join('.github', 'workflows');

const reportSchema = z.object({
  summary: z.object({
    supported: z.number(),
    translated: z.number(),
    unsupported: z.number(),
  }),
  workflows: z.array(
    z.object({
      path: z.string(),
      name: z.string(),
      status: z.enum(['supported', 'translated', 'unsupported']),
      findings: z.array(
        z.object({
          status: z.enum(['translated', 'unsupported']),
          line: z.number(),
          message: z.string(),
        }),
      ),
      pipeline: z.string().nullable(),
    }),
  ),
});
export type ActionsReport = z.infer<typeof reportSchema>;

/** `.github/workflows/*.yml` (and `.yaml`) under `dir`, by name. */
export async function readWorkflows(dir: string): Promise<Files> {
  const root = join(dir, WORKFLOW_DIR);
  const names = (await readdir(root).catch(() => [] as string[]))
    .filter((n) => /\.ya?ml$/.test(n))
    .sort();
  const files: Files = [];
  for (const name of names)
    files.push({
      path: `.github/workflows/${name}`,
      content: await readFile(join(root, name), 'utf8'),
    });
  return files;
}

export async function checkWorkflows(opts: {
  api: string;
  token?: string;
  /** Report a repository's own workflows (owner/name). */
  repo?: string;
  /** Revision for `repo`; the default branch when omitted. */
  head?: string;
  /** Local checkout to read workflows from when `repo` is not given. */
  dir?: string;
  fetch?: typeof fetch;
}): Promise<ActionsReport> {
  const base = `${opts.api.replace(/\/$/, '')}/api/v1`;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
  };
  let res: Response;
  if (opts.repo) {
    const query = opts.head ? `?head=${encodeURIComponent(opts.head)}` : '';
    res = await (opts.fetch ?? fetch)(`${base}/repos/${opts.repo}/ci/actions${query}`, {
      headers,
    });
  } else {
    const files = await readWorkflows(opts.dir ?? process.cwd());
    if (files.length === 0)
      throw new Error(`no workflow files in ${join(opts.dir ?? '.', WORKFLOW_DIR)}`);
    res = await (opts.fetch ?? fetch)(`${base}/ci/actions/check`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ files }),
    });
  }
  const payload = (await res.json().catch(() => null)) as {
    error?: { code: string; message: string };
  } | null;
  if (!res.ok) {
    const error = payload?.error;
    throw new Error(
      error
        ? `${error.code}: ${error.message}`
        : `actions check failed: HTTP ${res.status}`,
    );
  }
  return reportSchema.parse(payload);
}

/** One line per workflow, its findings under it, then the totals. */
export function formatReport(report: ActionsReport): string[] {
  const lines: string[] = [];
  for (const w of report.workflows) {
    lines.push(`${w.status.padEnd(11)} ${w.path}`);
    for (const f of w.findings)
      lines.push(`  ${w.path}:${f.line}: ${f.status}: ${f.message}`);
  }
  const { supported, translated, unsupported } = report.summary;
  lines.push(
    `${supported} supported, ${translated} translated, ${unsupported} unsupported`,
  );
  return lines;
}
