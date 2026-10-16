import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import type { Env } from '../env';
import type { RepoRecord } from '../db/client';
import { getRef } from '../db/repos';
import { getChangeset } from '../core/changesets';
import { getTree, resolvePath } from '../core/trees';
import { getBlob } from '../core/blobs';
import type { IssueTemplate, IssueTemplateField } from '../../shared/issues';

/**
 * Issue templates (issue #38) from the default branch: Markdown templates
 * with front matter and GitHub issue forms (`.yml`). `.yuma/ISSUE_TEMPLATE`
 * wins over `.github/ISSUE_TEMPLATE` (read for compatibility) on a name clash.
 */

const DIRS = ['.yuma/ISSUE_TEMPLATE', '.github/ISSUE_TEMPLATE'];
const MAX_TEMPLATES = 25;
const MAX_BYTES = 64 * 1024;

/** `labels: a, b` and `labels: [a, b]` are both valid in GitHub templates. */
const list = z
  .union([z.array(z.string()), z.string()])
  .optional()
  .transform((v) =>
    v === undefined
      ? []
      : (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter(Boolean),
  );

const meta = z.object({
  name: z.string().optional(),
  about: z.string().optional(),
  description: z.string().optional(),
  title: z.string().optional(),
  labels: list,
  assignees: list,
});

const field = z.object({
  type: z.enum(['markdown', 'textarea', 'input', 'dropdown', 'checkboxes']),
  id: z.string().optional(),
  attributes: z
    .object({
      label: z.string().optional(),
      description: z.string().optional(),
      placeholder: z.string().optional(),
      value: z.string().optional(),
      options: z.array(z.union([z.string(), z.object({ label: z.string() })])).optional(),
    })
    .default({}),
  validations: z.object({ required: z.boolean().optional() }).optional(),
});

const form = meta.extend({ name: z.string(), body: z.array(field).min(1) });

function parseTemplate(path: string, text: string): IssueTemplate {
  const base = { path, title: '', body: '', fields: [] as IssueTemplateField[] };
  if (/\.md$/i.test(path)) {
    const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
    const m = meta.parse(front ? (parseYaml(front[1] as string) ?? {}) : {});
    return {
      ...base,
      name: m.name ?? path.split('/').pop()!.replace(/\.md$/i, ''),
      about: m.about ?? '',
      title: m.title ?? '',
      labels: m.labels,
      assignees: m.assignees,
      body: front ? text.slice(front[0].length) : text,
    };
  }
  const f = form.parse(parseYaml(text));
  return {
    ...base,
    name: f.name,
    about: f.description ?? f.about ?? '',
    title: f.title ?? '',
    labels: f.labels,
    assignees: f.assignees,
    fields: f.body.map((b, i) => ({
      type: b.type,
      id: b.id ?? `field-${i}`,
      label: b.attributes.label ?? '',
      description: b.attributes.description ?? '',
      placeholder: b.attributes.placeholder ?? '',
      value: b.attributes.value ?? '',
      options: (b.attributes.options ?? []).map((o) =>
        typeof o === 'string' ? o : o.label,
      ),
      required: b.validations?.required ?? false,
    })),
  };
}

/**
 * Templates readable by the caller (`canRead` applies path rules per file).
 * Broken templates are reported in `errors` rather than dropped silently.
 */
export async function listTemplates(
  env: Env,
  repo: RepoRecord,
  canRead: (path: string) => boolean,
): Promise<{ templates: IssueTemplate[]; errors: { path: string; message: string }[] }> {
  const templates: IssueTemplate[] = [];
  const errors: { path: string; message: string }[] = [];
  const ref = await getRef(env, repo.id, repo.default_branch);
  const cs = ref ? await getChangeset(env, repo.id, ref.head) : null;
  if (!cs?.root_tree) return { templates, errors };
  const seen = new Set<string>();
  for (const dir of DIRS) {
    const entry = await resolvePath(env, repo.id, cs.root_tree, dir.split('/'));
    const tree = entry?.kind === 'tree' ? await getTree(env, repo.id, entry.hash) : null;
    for (const file of tree?.entries ?? []) {
      const path = `${dir}/${file.name}`;
      const key = file.name.toLowerCase();
      if (
        file.kind !== 'blob' ||
        !/\.(md|ya?ml)$/i.test(file.name) ||
        /^config\.ya?ml$/i.test(file.name) ||
        seen.has(key) ||
        !canRead(path) ||
        templates.length >= MAX_TEMPLATES
      )
        continue;
      seen.add(key);
      const blob = await getBlob(env, repo.id, file.hash);
      if (!blob || blob.size > MAX_BYTES) {
        errors.push({ path, message: 'Template is missing or larger than 64 KiB' });
        continue;
      }
      try {
        templates.push(parseTemplate(path, new TextDecoder().decode(blob.content)));
      } catch (err) {
        errors.push({
          path,
          message: err instanceof Error ? err.message.slice(0, 300) : 'Invalid template',
        });
      }
    }
  }
  return { templates, errors };
}
