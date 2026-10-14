import { Hono } from 'hono';
import type { Env } from '../env';
import { ancestryRoutes } from './ancestry';
import { blameRoutes } from './blame';
import { changesetsRoutes } from './changesets';
import { diffRoutes } from './diff';
import { readRoutes } from './read';
import { refsRoutes } from './refs';

/** `/api/v1` router. Routes are mounted as their issues land. */
export const apiRouter = new Hono<{ Bindings: Env }>();

apiRouter.get('/', (c) => c.json({ ok: true, service: 'yuma-agent-git', api: 'v1' }));

apiRouter.route('/', ancestryRoutes);
apiRouter.route('/', blameRoutes);
apiRouter.route('/', changesetsRoutes);
apiRouter.route('/', diffRoutes);
apiRouter.route('/', refsRoutes);
apiRouter.route('/', readRoutes);
