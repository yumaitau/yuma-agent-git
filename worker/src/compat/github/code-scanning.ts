import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../auth/principal';
import { SEVERITIES } from '../../security/deps/osv';
import { usersOf } from './users';
import {
  cursorOf,
  gh,
  iso,
  loadRepo,
  native,
  originOf,
  paged,
  parseGh,
  PREFIX,
} from './native';

/**
 * Code scanning alerts (#67) in GitHub's shape: the alerts on one ref (the
 * default branch unless `ref` names another), newest first, numbered by
 * their forge id. Read only, and only this list: people dismiss and reopen
 * on the native route.
 */
export const codeScanningRoutes = new Hono<AppEnv>();

export const ghCodeScanningQuery = z.object({
  ref: z.string().max(255).optional(),
  state: z.enum(['open', 'fixed', 'dismissed']).optional(),
  severity: z.string().optional().describe('critical, high, medium or low'),
  tool_name: z.string().max(100).optional(),
  per_page: z.coerce.number().int().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).optional(),
});

const alertSchema = z.looseObject({
  id: z.number(),
  ref: z.string(),
  tool: z.string(),
  category: z.string(),
  rule_id: z.string(),
  rule_name: z.string().nullable(),
  severity: z.enum(SEVERITIES),
  message: z.string(),
  path: z.string(),
  start_line: z.number().nullable(),
  end_line: z.number().nullable(),
  start_column: z.number().nullable(),
  end_column: z.number().nullable(),
  state: z.enum(['open', 'fixed', 'dismissed']),
  dismissed_reason: z.string().nullable(),
  dismissed_by: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});

const DISMISSED: Record<string, string> = {
  false_positive: 'false positive',
  wont_fix: "won't fix",
  used_in_tests: 'used in tests',
};
/** SARIF level GitHub reports beside the security severity. */
const RULE_SEVERITY: Record<string, string> = {
  critical: 'error',
  high: 'error',
  medium: 'warning',
  low: 'note',
};

codeScanningRoutes.get(
  `${PREFIX}/repos/:owner/:repo/code-scanning/alerts`,
  gh(async (c) => {
    const repo = await loadRepo(c);
    const query = parseGh(ghCodeScanningQuery, c.req.query());
    const params = new URLSearchParams();
    if (query.ref) params.set('ref', query.ref);
    if (query.state) params.set('state', query.state);
    // GitHub's other levels (error, warning, note) have no forge equivalent
    if (query.severity && (SEVERITIES as readonly string[]).includes(query.severity))
      params.set('severity', query.severity);
    if (query.tool_name) params.set('tool', query.tool_name);
    const { items } = await paged(c, async (cursor) => {
      if (cursor !== null) params.set('cursor', cursor);
      const page = z
        .object({ alerts: z.array(alertSchema), next_cursor: z.string().nullable() })
        .parse(await native(c, 'GET', `${repo.path}/code-scanning/alerts?${params}`));
      return { items: page.alerts, next: cursorOf(page.next_cursor) };
    });
    const toUser = await usersOf(
      c,
      items.flatMap((a) => (a.dismissed_by ? [`user:${a.dismissed_by}`] : [])),
    );
    const html = `${originOf(c)}/r/${repo.record.slug}/security-alerts`;
    return c.json(
      await Promise.all(
        items.map(async (a) => ({
          number: a.id,
          created_at: iso(a.created_at),
          updated_at: iso(a.updated_at),
          html_url: html,
          state: a.state,
          fixed_at: a.state === 'fixed' ? iso(a.updated_at) : null,
          dismissed_by: a.dismissed_by ? await toUser(`user:${a.dismissed_by}`) : null,
          dismissed_at: a.state === 'dismissed' ? iso(a.updated_at) : null,
          dismissed_reason: a.dismissed_reason
            ? (DISMISSED[a.dismissed_reason] ?? a.dismissed_reason)
            : null,
          dismissed_comment: null,
          rule: {
            id: a.rule_id,
            name: a.rule_name ?? a.rule_id,
            severity: RULE_SEVERITY[a.severity],
            security_severity_level: a.severity,
            description: a.rule_name ?? a.rule_id,
            tags: [],
          },
          tool: { name: a.tool, guid: null, version: null },
          most_recent_instance: {
            // branches are stored by name, pull request refs in full
            ref: a.ref.startsWith('refs/') ? a.ref : `refs/heads/${a.ref}`,
            analysis_key: a.category,
            category: a.category,
            environment: '{}',
            state: a.state,
            commit_sha: null,
            message: { text: a.message },
            location: {
              path: a.path,
              start_line: a.start_line,
              end_line: a.end_line,
              start_column: a.start_column,
              end_column: a.end_column,
            },
            classifications: [],
          },
        })),
      ),
    );
  }),
);
