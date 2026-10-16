import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../auth/principal';
import { principalNames } from '../../api/issues';
import { numericId } from '../../webhooks/payloads';
import { apiUrl, gh, native, originOf, PREFIX, type Ctx } from './native';

/** GitHub `user` object for a forge principal (`user:<id>`, `agent:<id>`, `team:<id>`). */
export interface GhUser {
  login: string;
  id: number;
  node_id: string;
  type: 'User' | 'Bot' | 'Organization';
  url: string;
  html_url: string;
}
type Users = (principal: string) => Promise<GhUser>;

/** One login lookup for a page of principals, then a mapper. */
export async function usersOf(c: Ctx, principals: string[]): Promise<Users> {
  const names = await principalNames(c, principals);
  return async (principal: string) => {
    const login = names[principal] ?? principal;
    const kind = principal.split(':', 1)[0];
    return {
      login,
      id: await numericId(principal.slice(principal.indexOf(':') + 1)),
      node_id: principal,
      type: kind === 'user' ? 'User' : kind === 'team' ? 'Organization' : 'Bot',
      url: apiUrl(c, `/users/${encodeURIComponent(login)}`),
      html_url: originOf(c),
    };
  };
}

export const usersRoutes = new Hono<AppEnv>();

usersRoutes.get(
  PREFIX,
  gh(async (c) => {
    await native(c, 'GET', '/user'); // any signed-in caller
    return c.json({
      current_user_url: apiUrl(c, '/user'),
      repository_url: apiUrl(c, '/repos/{owner}/{repo}'),
      issue_search_url: apiUrl(c, '/search/issues?q={query}'),
    });
  }),
);

usersRoutes.get(
  `${PREFIX}/user`,
  gh(async (c) => {
    const { user } = z
      .object({ user: z.object({ id: z.string(), login: z.string() }) })
      .parse(await native(c, 'GET', '/user'));
    const toUser = await usersOf(c, [`user:${user.id}`]);
    return c.json(await toUser(`user:${user.id}`));
  }),
);
