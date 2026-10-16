import { describe, expect, it } from 'vitest';
import { YagApi } from '../src/api.js';
import { formatRelease, sha256Hex, uncovered } from '../src/release.js';

const release = {
  id: 'rel_1',
  tag: 'v1.0.0',
  name: 'v1.0.0',
  body: '',
  draft: false,
  prerelease: true,
  latest: false,
  target_cs: 'c'.repeat(64),
  assets: [{ id: 'ast_1', name: 'app.tar.gz', size: 4, sha256: 'a'.repeat(64) }],
};

function fakeApi(respond: (req: Request) => Response): {
  api: YagApi;
  requests: Request[];
} {
  const requests: Request[] = [];
  const api = new YagApi({
    api: 'https://yag.test',
    repo: 'acme/app',
    token: 'yagpat_x',
    fetchFn: async (input) => {
      const req = input as Request;
      requests.push(req);
      return respond(req);
    },
  });
  return { api, requests };
}

describe('yag release', () => {
  it('uploads raw bytes with the local SHA-256 for the server to check', async () => {
    const { api, requests } = fakeApi(() =>
      Response.json({ asset: release.assets[0] }, { status: 201 }),
    );
    const bytes = new TextEncoder().encode('bits');
    const digest = await sha256Hex(bytes);
    await api.uploadAsset('rel_1', 'app.tar.gz', bytes, digest);
    const [req] = requests;
    expect(req!.method).toBe('POST');
    expect(req!.url).toBe(
      `https://yag.test/api/v1/repos/acme/app/releases/rel_1/assets?name=app.tar.gz&sha256=${digest}`,
    );
    expect(req!.headers.get('content-type')).toBe('application/octet-stream');
    expect(new Uint8Array(await req!.arrayBuffer())).toEqual(bytes);
  });

  it('finds releases by tag and reads the public JWKS without a token', async () => {
    const { api, requests } = fakeApi((req) =>
      req.url.endsWith('/jwks')
        ? Response.json({ keys: [] })
        : Response.json({ release }),
    );
    expect((await api.getRelease('release/1.0')).id).toBe('rel_1');
    expect(requests[0]!.url).toBe(
      'https://yag.test/api/v1/repos/acme/app/releases/tags/release%2F1.0',
    );
    expect(await api.jwks()).toEqual({ keys: [] });
    expect(requests[1]!.url).toBe('https://yag.test/ci/oidc/jwks');
    expect(requests[1]!.headers.get('authorization')).toBeNull();
  });

  it('formats releases and reports assets without verified provenance', () => {
    expect(formatRelease(release)).toBe('v1.0.0 (prerelease) 1 asset');
    const statement = {
      _type: 'https://in-toto.io/Statement/v1' as const,
      predicateType: 'https://slsa.dev/provenance/v1',
      subject: [{ name: 'app.tar.gz', digest: { sha256: 'a'.repeat(64) } }],
    };
    expect(uncovered(release.assets, [statement])).toEqual([]);
    expect(
      uncovered([{ name: 'app.tar.gz', sha256: 'b'.repeat(64) }], [statement]),
    ).toEqual(['app.tar.gz']);
  });
});
