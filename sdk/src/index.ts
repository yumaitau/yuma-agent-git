import createClient, { type Client } from 'openapi-fetch';
import type { operations, paths } from './schema.js';

export type { components, operations, paths } from './schema.js';

/**
 * Typed client for the yuma-agent-git API (issue #28). Types come from
 * `src/schema.ts`, generated from docs/openapi.json by `npm run docs:openapi`;
 * requests go through openapi-fetch, e.g.
 *
 *   const yag = createYagClient({ baseUrl, token });
 *   const { data, error } = await yag.GET('/api/v1/repos/{owner}/{repo}/refs', {
 *     params: { path: { owner, repo }, query: { limit: 50 } },
 *   });
 *
 * Errors arrive in `error` as the `{ error: { code, message } }` envelope.
 */
export function createYagClient(opts: {
  baseUrl: string;
  /** API token (`yag_…`); omit for browser session cookies. */
  token?: string;
  fetch?: typeof fetch;
}): Client<paths> {
  return createClient<paths>({
    baseUrl: opts.baseUrl.replace(/\/$/, ''),
    fetch: opts.fetch,
    headers: opts.token ? { authorization: `Bearer ${opts.token}` } : undefined,
  });
}

/** JSON request body of an operation, by `operationId`. */
export type RequestBody<Id extends keyof operations> = operations[Id] extends {
  requestBody: { content: { 'application/json': infer Body } };
}
  ? Body
  : never;

/** Query parameters of an operation, by `operationId`. */
export type QueryParams<Id extends keyof operations> = NonNullable<
  operations[Id]['parameters']['query']
>;
