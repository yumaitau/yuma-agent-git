import type { Env } from '../../env';
import { q1 } from '../../db/client';
import { getBlob } from '../../core/blobs';
import { getChangeset } from '../../core/changesets';
import { getTree, resolvePath } from '../../core/trees';
import { MAX_FILE_BYTES, MAX_FILES, type PipelineFile } from '../spec';
import { translateWorkflow, type CompatStatus, type WorkflowReport } from './translate';

/**
 * GitHub Actions compatibility (issue #49): read `.github/workflows/*.yml`
 * at a revision and translate each file. Repositories opt in per repo
 * (`ci_actions_settings`) before their workflows run as pipelines, and only
 * when they have no `.yuma/pipelines` files (ci/spec.ts).
 */
export const WORKFLOW_DIR = ['.github', 'workflows'];

export interface Analysis {
  reports: WorkflowReport[];
  /** What CI runs: translated pipelines, or line-numbered errors. */
  files: PipelineFile[];
}

function unreadable(path: string, message: string): Analysis {
  return {
    reports: [
      {
        path,
        name: path.slice(path.lastIndexOf('/') + 1),
        status: 'unsupported',
        findings: [{ status: 'unsupported', line: 1, message }],
        pipeline: null,
      },
    ],
    files: [{ path, errors: [{ line: 1, column: 1, message }] }],
  };
}

/** Translate workflow texts, in the order given. */
export function analyseTexts(files: { path: string; content: string }[]): Analysis {
  const out: Analysis = { reports: [], files: [] };
  for (const f of files) {
    const { report, file } = translateWorkflow(f.path, f.content);
    out.reports.push(report);
    out.files.push(file);
  }
  return out;
}

/** Every workflow file under a root tree, sorted by path, with the pipeline file limits. */
export async function analyseTree(
  env: Env,
  repoId: string,
  rootTree: string,
): Promise<Analysis> {
  const dir = await resolvePath(env, repoId, rootTree, WORKFLOW_DIR);
  const tree = dir?.kind === 'tree' ? await getTree(env, repoId, dir.hash) : null;
  const entries = (tree?.entries ?? [])
    .filter((e) => e.kind === 'blob' && /\.ya?ml$/.test(e.name))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  const out: Analysis = { reports: [], files: [] };
  const add = (a: Analysis): void => {
    out.reports.push(...a.reports);
    out.files.push(...a.files);
  };
  for (const [i, entry] of entries.entries()) {
    const path = `${WORKFLOW_DIR.join('/')}/${entry.name}`;
    if (i >= MAX_FILES) {
      add(unreadable(path, `Use ${MAX_FILES} workflow files at most`));
      continue;
    }
    const blob = await getBlob(env, repoId, entry.hash);
    if (!blob || blob.content.byteLength > MAX_FILE_BYTES) {
      add(unreadable(path, `Workflow files are limited to ${MAX_FILE_BYTES / 1024} KiB`));
      continue;
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
        blob.content,
      );
    } catch {
      add(unreadable(path, 'Workflow files must be UTF-8 text'));
      continue;
    }
    add(analyseTexts([{ path, content: text }]));
  }
  return out;
}

export async function analyseRevision(
  env: Env,
  repoId: string,
  csId: string,
): Promise<Analysis> {
  const cs = await getChangeset(env, repoId, csId);
  return cs?.root_tree
    ? analyseTree(env, repoId, cs.root_tree)
    : { reports: [], files: [] };
}

/** Whether the repo runs its workflows when it has no pipeline files. */
export async function actionsEnabled(env: Env, repoId: string): Promise<boolean> {
  const row = await q1<{ enabled: number }>(
    env,
    'SELECT enabled FROM ci_actions_settings WHERE repo_id = ?',
    [repoId],
  );
  return row?.enabled === 1;
}

export function summarise(reports: WorkflowReport[]): Record<CompatStatus, number> {
  const out: Record<CompatStatus, number> = {
    supported: 0,
    translated: 0,
    unsupported: 0,
  };
  for (const r of reports) out[r.status]++;
  return out;
}
