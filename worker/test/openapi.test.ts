import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import document from '../../docs/openapi.json';
import { app } from '../src/app';
import { API_CONTRACT, displayPath, jsonSchema, openApiPath } from '../src/api/contract';
import { cleanDb, loginAs, makeApp, seedSchema } from './helpers';
import type { TestEnv } from './helpers';

const testEnv = env as unknown as TestEnv;

interface Operation {
  operationId: string;
  parameters?: { name: string; in: string; schema: unknown }[];
  requestBody?: { content: Record<string, { schema: unknown }> };
}

const paths = document.paths as unknown as Record<string, Record<string, Operation>>;

/** Every mounted route (middleware `ALL` entries skipped), once. */
const routes = [
  ...new Map(
    app.routes
      .filter((r) => r.method !== 'ALL')
      .map((r) => [`${r.method} ${r.path}`, { method: r.method, path: r.path }]),
  ).values(),
];

function operation(method: string, path: string): Operation | undefined {
  return paths[openApiPath(path)]?.[method.toLowerCase()];
}

describe('docs/openapi.json (issue #28)', () => {
  it('describes every route mounted in app.ts, the API router and auth/*', () => {
    const missing = routes
      .filter((r) => !operation(r.method, r.path))
      .map((r) => `${r.method} ${r.path}`);
    expect(missing).toEqual([]);
    const described = Object.values(paths).reduce((n, p) => n + Object.keys(p).length, 0);
    expect(described).toBe(routes.length);
  });

  it('has exactly one contract entry per route', () => {
    const keys = routes.map((r) => `${r.method} ${displayPath(r.path)}`);
    expect(keys.filter((k) => !API_CONTRACT[k])).toEqual([]);
    expect(Object.keys(API_CONTRACT).filter((k) => !keys.includes(k))).toEqual([]);
  });

  it('matches the current zod schemas (run `npm run docs:openapi` after a change)', () => {
    for (const r of routes) {
      const contract = API_CONTRACT[`${r.method} ${displayPath(r.path)}`];
      const op = operation(r.method, r.path);
      if (!contract || !op) continue; // reported by the tests above
      expect(op.operationId).toBe(contract.id);
      const media = contract.body ? 'application/json' : contract.rawBody;
      expect(op.requestBody, `${r.method} ${r.path}`).toEqual(
        media && {
          required: true,
          content: {
            [media]: { schema: contract.body ? jsonSchema(contract.body) : {} },
          },
        },
      );
      const query = Object.fromEntries(
        (op.parameters ?? [])
          .filter((p) => p.in === 'query')
          .map((p) => [p.name, p.schema]),
      );
      const declared = Object.fromEntries(
        Object.entries(contract.query?.shape ?? {}).map(([name, field]) => [
          name,
          jsonSchema(field),
        ]),
      );
      expect(query, `${r.method} ${r.path}`).toEqual(declared);
    }
  });
});

describe('GET /api/v1/openapi.json', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
  });

  it('refuses anonymous callers like the rest of /api', async () => {
    const res = await makeApp(testEnv)(new Request('http://x/api/v1/openapi.json'));
    expect(res.status).toBe(401);
  });

  it('serves the committed document to signed-in callers', async () => {
    const { headers } = await loginAs(testEnv, 4242, 'reader');
    const res = await makeApp(testEnv)(
      new Request('http://x/api/v1/openapi.json', { headers }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, max-age=300');
    expect(await res.json()).toEqual(document);
  });
});
