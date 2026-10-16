import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../auth/principal';
import { ApiError } from '../../core/errors';
import { gh, loadRepo, parseGh, PREFIX } from './native';
import { ghIssues, listIssues, nativeIssueQuery } from './issues';
import { ghPull, listPulls } from './pulls';

/**
 * `GET /search/issues` for one repository (`repo:owner/name` is required).
 * Qualifiers map onto the native list filters: `is:issue`/`is:pr` (or
 * `type:`), `is:open`/`is:closed` (or `state:`), `label:` and `assignee:`
 * (issues only). Without `is:pr` only issues are searched. Other words must
 * all appear in the title or body; that
 * match runs over at most 20 native pages, so `incomplete_results` is true
 * when the walk stopped before the end.
 */
export const searchRoutes = new Hono<AppEnv>();

export const searchIssuesQuery = z.object({
  q: z
    .string()
    .min(1)
    .describe('Search terms and qualifiers; `repo:owner/name` required'),
  per_page: z.coerce.number().int().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).optional(),
});

interface Parsed {
  repo: string;
  kind: 'issue' | 'pr' | null;
  state: 'open' | 'closed' | 'all';
  labels: string[];
  assignee?: string;
  words: string[];
}

export function parseQuery(q: string): Parsed {
  const out: Parsed = { repo: '', kind: null, state: 'all', labels: [], words: [] };
  for (const token of q.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []) {
    const [key, ...rest] = token.split(':');
    const value = rest.join(':').replace(/^"|"$/g, '');
    if (rest.length === 0 || value === '') {
      out.words.push(token.replace(/^"|"$/g, '').toLowerCase());
    } else if (key === 'repo') out.repo = value;
    else if ((key === 'is' || key === 'type') && (value === 'issue' || value === 'pr'))
      out.kind = value;
    else if (
      (key === 'is' || key === 'state') &&
      (value === 'open' || value === 'closed')
    )
      out.state = value;
    else if (key === 'label') out.labels.push(value);
    else if (key === 'assignee') out.assignee = value;
    else throw new ApiError(422, 'validation_failed', `Unsupported qualifier ${key}:`);
  }
  if (!/^[^/]+\/[^/]+$/.test(out.repo))
    throw new ApiError(
      422,
      'validation_failed',
      'A repo:owner/name qualifier is required',
    );
  return out;
}

const matches = (words: string[], text: string): boolean => {
  const lower = text.toLowerCase();
  return words.every((w) => lower.includes(w));
};

searchRoutes.get(
  `${PREFIX}/search/issues`,
  gh(async (c) => {
    const query = parseGh(searchIssuesQuery, c.req.query());
    const parsed = parseQuery(query.q);
    const repo = await loadRepo(c, parsed.repo);
    if (parsed.kind === 'pr') {
      if (parsed.labels.length || parsed.assignee)
        throw new ApiError(
          422,
          'validation_failed',
          'label: and assignee: need is:issue',
        );
      const found = await listPulls(c, repo, parsed.state, (p) =>
        matches(parsed.words, `${p.title}\n${p.body}`),
      );
      const items = await Promise.all(
        found.items.map(async (p) => {
          const pull = await ghPull(c, repo, p);
          return {
            ...pull,
            url: pull.issue_url,
            pull_request: { url: pull.url, html_url: pull.html_url },
          };
        }),
      );
      return c.json({
        total_count: found.seen,
        incomplete_results: !found.complete,
        items,
      });
    }
    const found = await listIssues(
      c,
      repo,
      nativeIssueQuery({
        state: parsed.state,
        labels: parsed.labels.join(','),
        assignee: parsed.assignee,
      }),
      (i) => matches(parsed.words, `${i.title}\n${i.body}`),
    );
    return c.json({
      total_count: found.seen,
      incomplete_results: !found.complete,
      items: await ghIssues(c, repo, found.items),
    });
  }),
);
