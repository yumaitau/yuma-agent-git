import { Hono } from 'hono';
import type { AppEnv } from '../../auth/principal';
import { PREFIX } from './native';
import { usersRoutes } from './users';
import { reposRoutes } from './repos';
import { contentsRoutes } from './contents';
import { issuesRoutes } from './issues';
import { pullsRoutes } from './pulls';
import { checksRoutes } from './checks';
import { codeScanningRoutes } from './code-scanning';
import { releasesRoutes } from './releases';
import { searchRoutes } from './search';

/**
 * GitHub REST compatible subset at `/api/github/v3` (issue #74); see
 * docs/compat/github.md. `/api/v3/…` is an alias, the path `gh` uses for a
 * GitHub Enterprise host (`GH_HOST`).
 */
export const githubCompatRoutes = new Hono<AppEnv>();

githubCompatRoutes.all('/api/v3/*', async (c) => {
  const url = new URL(c.req.url);
  url.pathname = `${PREFIX}${url.pathname.slice('/api/v3'.length).replace(/^\/$/, '')}`;
  // lazy: app.ts mounts this module
  const { app } = await import('../../app');
  return app.fetch(new Request(url, c.req.raw), c.env, c.executionCtx);
});

for (const routes of [
  usersRoutes,
  reposRoutes,
  contentsRoutes,
  issuesRoutes,
  pullsRoutes,
  checksRoutes,
  codeScanningRoutes,
  releasesRoutes,
  searchRoutes,
]) {
  githubCompatRoutes.route('/', routes);
}
