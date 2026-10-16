import { Hono } from 'hono';
import type { Env } from '../env';
import { collaborationRoutes } from './collaboration';
import { agentsRoutes } from './agents';
import { auditRoutes } from './audit';
import { ancestryRoutes } from './ancestry';
import { blameRoutes } from './blame';
import { changesetsRoutes } from './changesets';
import { mcpRoutes } from '../agents/mcp';
import { diffRoutes } from './diff';
import { exportRoutes } from './export';
import { importRoutes } from './imports';
import { objectsRoutes } from './objects';
import { orgsRoutes } from './orgs';
import { orgSsoRoutes } from './org-sso';
import { readRoutes } from './read';
import { refsRoutes } from './refs';

/** `/api/v1` router. Routes are mounted as their issues land. */
export const apiRouter = new Hono<{ Bindings: Env }>();

apiRouter.get('/', (c) => c.json({ ok: true, service: 'yuma-agent-git', api: 'v1' }));

apiRouter.route('/', collaborationRoutes);
apiRouter.route('/', agentsRoutes);
apiRouter.route('/', auditRoutes);
apiRouter.route('/', ancestryRoutes);
apiRouter.route('/', blameRoutes);
apiRouter.route('/', changesetsRoutes);
apiRouter.route('/', mcpRoutes);
apiRouter.route('/', diffRoutes);
apiRouter.route('/', exportRoutes);
apiRouter.route('/', importRoutes);
apiRouter.route('/', refsRoutes);
apiRouter.route('/', objectsRoutes);
apiRouter.route('/', orgsRoutes);
apiRouter.route('/', orgSsoRoutes);
apiRouter.route('/', readRoutes);
