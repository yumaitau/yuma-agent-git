import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, setUnauthorizedHandler } from './api';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  setUnauthorizedHandler(null);
  vi.unstubAllGlobals();
});

describe('api client error mapping', () => {
  it('sends 401 through the login redirect', async () => {
    const on401 = vi.fn();
    setUnauthorizedHandler(on401);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json(401, { error: { code: 'unauthorized', message: 'session required' } }),
      ),
    );
    await expect(api.listRepos()).rejects.toMatchObject({
      status: 401,
      code: 'unauthorized',
    });
    expect(on401).toHaveBeenCalledOnce();
  });

  it('surfaces denied_by from a 403', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json(403, {
          error: {
            code: 'forbidden',
            message: 'path rule denies this path',
            denied_by: {
              id: 7,
              path_prefix: 'secrets/',
              effect: 'deny',
              principal: '*',
            },
          },
        }),
      ),
    );
    const err = await api.listRepos().then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).deniedBy).toEqual({
      id: 7,
      path_prefix: 'secrets/',
      effect: 'deny',
      principal: '*',
    });
  });

  it('surfaces expected and actual from a 409 ref_stale', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json(409, {
          error: {
            code: 'ref_stale',
            message: 'ref moved',
            expected: 'aaa',
            actual: 'bbb',
          },
        }),
      ),
    );
    const err = await api.listRepos().then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('ref_stale');
    expect((err as ApiError).expected).toBe('aaa');
    expect((err as ApiError).actual).toBe('bbb');
  });
});
