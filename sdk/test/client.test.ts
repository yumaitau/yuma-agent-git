import { describe, expect, it } from 'vitest';
import { createYagClient, type QueryParams, type RequestBody } from '../src/index.js';

function recorder(): { fetch: typeof fetch; requests: Request[] } {
  const requests: Request[] = [];
  return {
    requests,
    fetch: async (input) => {
      requests.push(input as Request);
      return Response.json({ refs: [], next_cursor: null });
    },
  };
}

describe('createYagClient', () => {
  it('expands {owner}/{repo}, serialises query and sends the token', async () => {
    const { fetch, requests } = recorder();
    const yag = createYagClient({ baseUrl: 'https://yag.test/', token: 'yag_x', fetch });
    const query: QueryParams<'listRefs'> = { prefix: 'refs/tags/', limit: 2 };
    const { data } = await yag.GET('/api/v1/repos/{owner}/{repo}/refs', {
      params: { path: { owner: 'acme', repo: 'site' }, query },
    });
    expect(data).toEqual({ refs: [], next_cursor: null });
    const req = requests[0] as Request;
    expect(req.url).toBe(
      'https://yag.test/api/v1/repos/acme/site/refs?prefix=refs%2Ftags%2F&limit=2',
    );
    expect(req.headers.get('authorization')).toBe('Bearer yag_x');
  });

  it('sends JSON bodies typed from the zod request schemas', async () => {
    const { fetch, requests } = recorder();
    const yag = createYagClient({ baseUrl: 'https://yag.test', fetch });
    const body: RequestBody<'moveRef'> = { from: null, to: 'abc' };
    await yag.PUT('/api/v1/repos/{owner}/{repo}/refs/{name}', {
      params: { path: { owner: 'acme', repo: 'site', name: 'main' } },
      body,
    });
    const req = requests[0] as Request;
    expect(req.method).toBe('PUT');
    expect(req.headers.get('authorization')).toBeNull();
    expect(await req.json()).toEqual({ from: null, to: 'abc' });
  });

  it('rejects bodies the contract does not allow (type level)', () => {
    // @ts-expect-error `to` is required by moveRefSchema
    const missing: RequestBody<'moveRef'> = { from: null };
    const review: RequestBody<'reviewPull'> = {
      head_cs: 'a',
      revision: 1,
      // @ts-expect-error decision is an enum
      decision: 'lgtm',
      body: '',
    };
    expect([missing, review]).toHaveLength(2);
  });
});
