import { z } from 'zod';
import type { QueryParams, RequestBody } from '@yuma/agent-git-sdk';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: unknown = undefined,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const treeObjectSchema = z.object({
  hash: z.string(),
  entries: z.array(
    z.object({
      name: z.string(),
      kind: z.enum(['tree', 'blob']),
      hash: z.string(),
      size: z.number().optional(),
      mode: z.string().optional(),
    }),
  ),
});
export type TreeObject = z.infer<typeof treeObjectSchema>;

const fetchObjectsResultSchema = z.object({
  trees: z.array(z.object({ hash: z.string(), payload_b64: z.string() })),
  blobs: z.array(
    z.object({
      hash: z.string(),
      size: z.number(),
      encoding: z.string(),
      data_b64: z.string(),
    }),
  ),
  missing: z.array(z.string()),
});
export type FetchObjectsResult = z.infer<typeof fetchObjectsResultSchema>;

const checkoutInfoSchema = z.object({
  cs: z.string(),
  root_tree: z.string(),
  size_estimate: z.object({ blobs: z.number(), bytes: z.number() }),
});

const commitResultSchema = z.object({
  changeset: z.object({
    id: z.string(),
    root_tree: z.string().nullable(),
    changed_files: z.array(z.object({ path: z.string(), op: z.string() })),
  }),
  deduped: z.boolean(),
});

const diffResultSchema = z.object({
  from: z.string(),
  to: z.string(),
  merge_base: z.string().nullable(),
  files: z.array(
    z.object({
      path: z.string(),
      kind: z.string(),
      side: z.string().optional(),
    }),
  ),
  truncated: z.boolean(),
  texts: z
    .array(
      z.object({ path: z.string(), unified: z.string(), side: z.string().optional() }),
    )
    .optional(),
});

const historyResultSchema = z.object({
  changesets: z.array(
    z.object({
      id: z.string(),
      message: z.string(),
      created_at: z.number(),
      author: z.unknown(),
    }),
  ),
  next: z.string().nullable().optional(),
  complete: z.boolean().optional(),
});

const workItemSchema = z.object({
  number: z.number(),
  title: z.string(),
  readiness: z.string(),
  risk: z.string(),
  priority: z.number(),
  claimed_by: z.string().nullable(),
  lease_expires_at: z.number().nullable(),
  attempts: z.number(),
  waiting_on: z.array(z.number()),
});
export type WorkItem = z.infer<typeof workItemSchema>;

const releaseAssetSchema = z.object({
  id: z.string(),
  name: z.string(),
  size: z.number(),
  sha256: z.string(),
});
const releaseSchema = z.object({
  id: z.string(),
  tag: z.string(),
  name: z.string(),
  body: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  latest: z.boolean(),
  target_cs: z.string(),
  assets: z.array(releaseAssetSchema),
});
export type Release = z.infer<typeof releaseSchema>;
const attestationSchema = z.object({
  id: z.string(),
  run_id: z.string(),
  envelope: z.unknown(),
});

export interface UploadBlobResult {
  sha256: string;
  size: number;
  deduped: boolean;
}

/**
 * Thin client for the yuma-agent-git RPC surface. All negotiation is
 * **want-only**: request bodies ask for objects by hash and never declare what
 * the client already has (architecture §2.4).
 */
export class YagApi {
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly opts: {
      api: string;
      repo: string;
      token?: string;
      fetchFn?: typeof fetch;
    },
  ) {
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.opts.token) headers.set('authorization', `Bearer ${this.opts.token}`);
    if (init.body && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
    const res = await this.fetchFn(
      new Request(
        `${this.opts.api.replace(/\/$/, '')}/api/v1/repos/${this.opts.repo}${path}`,
        {
          ...init,
          headers,
        },
      ),
    );
    if (!res.ok) {
      let code = 'http_error';
      let message = `${res.status} ${res.statusText}`;
      let body: unknown;
      try {
        body = await res.json();
        const err = (body as { error?: { code?: string; message?: string } }).error;
        if (err) {
          code = err.code ?? code;
          message = err.message ?? message;
        }
      } catch {
        /* non-JSON error body */
      }
      if (res.status === 401 && !this.opts.token) {
        message +=
          ' (create an API token in the dashboard Settings and pass --token or set YAG_TOKEN)';
      }
      throw new ApiError(res.status, code, message, body);
    }
    return res;
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.request(path, init);
    return (await res.json()) as T;
  }

  async runCI(
    head?: string,
    publish = false,
  ): Promise<{ run: { id: string; state: string } }> {
    const body: RequestBody<'createCiRun'> = { head, publish };
    return this.json('/ci/runs', { method: 'POST', body: JSON.stringify(body) });
  }
  async ciStatus(): Promise<{
    enabled: boolean;
    runs: { id: string; head_cs: string; state: string }[];
  }> {
    return this.json('/ci');
  }
  async checkoutInfo(cs: string): Promise<z.infer<typeof checkoutInfoSchema>> {
    return checkoutInfoSchema.parse(
      await this.json(`/checkout-info?cs=${encodeURIComponent(cs)}`),
    );
  }

  async fetchObjects(body: RequestBody<'fetchObjects'>): Promise<FetchObjectsResult> {
    return fetchObjectsResultSchema.parse(
      await this.json('/fetch-objects', { method: 'POST', body: JSON.stringify(body) }),
    );
  }

  async getTree(hash: string): Promise<TreeObject> {
    return treeObjectSchema.parse(await this.json(`/object/tree/${hash}`));
  }

  async uploadBlob(hash: string, bytes: Buffer): Promise<UploadBlobResult> {
    return this.json<UploadBlobResult>(`/blob?sha256=${hash}&encoding=identity`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(bytes),
    });
  }

  async createChangeset(
    body: RequestBody<'createChangeset'>,
  ): Promise<z.infer<typeof commitResultSchema>> {
    return commitResultSchema.parse(
      await this.json('/changesets', { method: 'POST', body: JSON.stringify(body) }),
    );
  }

  async getRef(name: string): Promise<{ name: string; head: string } | null> {
    try {
      return (await this.json(`/refs/${name}`)) as { name: string; head: string };
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }

  async moveRef(
    name: string,
    body: RequestBody<'moveRef'>,
  ): Promise<{ ok: boolean; from: string | null; to: string }> {
    return (await this.json(`/refs/${name}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    })) as { ok: boolean; from: string | null; to: string };
  }

  async diff(from: string, to: string): Promise<z.infer<typeof diffResultSchema>> {
    return diffResultSchema.parse(
      await this.json(
        `/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&text=1`,
      ),
    );
  }

  async listWork(query: QueryParams<'listWork'> = {}): Promise<{ items: WorkItem[] }> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const qs = params.toString();
    return z
      .object({ items: z.array(workItemSchema) })
      .parse(await this.json(`/work${qs ? `?${qs}` : ''}`));
  }

  async claimWork(body: RequestBody<'claimWork'>): Promise<WorkItem | null> {
    const result = await this.json('/work/claim', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return z.object({ item: workItemSchema.nullable() }).parse(result).item;
  }

  async heartbeatWork(
    number: number,
    body: RequestBody<'heartbeatWork'>,
  ): Promise<{ lease_expires_at: number }> {
    const result = await this.json(`/work/${number}/heartbeat`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return z.object({ lease_expires_at: z.number() }).parse(result);
  }

  async releaseWork(number: number, body: RequestBody<'releaseWork'>): Promise<WorkItem> {
    const result = await this.json(`/work/${number}/release`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return z.object({ item: workItemSchema }).parse(result).item;
  }

  async updateWork(number: number, body: RequestBody<'updateWork'>): Promise<WorkItem> {
    const result = await this.json(`/work/${number}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    return z.object({ item: workItemSchema }).parse(result).item;
  }

  async listReleases(): Promise<Release[]> {
    return z
      .object({ releases: z.array(releaseSchema) })
      .parse(await this.json('/releases?limit=100')).releases;
  }

  async getRelease(tag: string): Promise<Release> {
    return z
      .object({ release: releaseSchema })
      .parse(await this.json(`/releases/tags/${encodeURIComponent(tag)}`)).release;
  }

  async createRelease(body: RequestBody<'createRelease'>): Promise<Release> {
    const result = await this.json('/releases', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return z.object({ release: releaseSchema }).parse(result).release;
  }

  async updateRelease(id: string, body: RequestBody<'updateRelease'>): Promise<Release> {
    const result = await this.json(`/releases/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    return z.object({ release: releaseSchema }).parse(result).release;
  }

  async deleteRelease(id: string): Promise<void> {
    await this.request(`/releases/${id}`, { method: 'DELETE' });
  }

  /** `idToken`: a CI job's ID token, so the asset records the run that built it. */
  async uploadAsset(
    releaseId: string,
    name: string,
    bytes: Uint8Array,
    sha256: string,
    idToken?: string,
  ): Promise<z.infer<typeof releaseAssetSchema>> {
    const result = await this.json(
      `/releases/${releaseId}/assets?name=${encodeURIComponent(name)}&sha256=${sha256}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          ...(idToken ? { 'x-yag-id-token': idToken } : {}),
        },
        body: new Uint8Array(bytes),
      },
    );
    return z.object({ asset: releaseAssetSchema }).parse(result).asset;
  }

  /** Asset bytes; the server aborts the body if they fail its stored SHA-256. */
  async downloadAsset(releaseId: string, assetId: string): Promise<Uint8Array> {
    const res = await this.request(`/releases/${releaseId}/assets/${assetId}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async attestRelease(
    releaseId: string,
    body: RequestBody<'createReleaseAttestation'>,
  ): Promise<z.infer<typeof attestationSchema>> {
    const result = await this.json(`/releases/${releaseId}/attestations`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return z.object({ attestation: attestationSchema }).parse(result).attestation;
  }

  async listAttestations(
    releaseId: string,
  ): Promise<z.infer<typeof attestationSchema>[]> {
    return z
      .object({ attestations: z.array(attestationSchema) })
      .parse(await this.json(`/releases/${releaseId}/attestations`)).attestations;
  }

  /** The forge's published CI signing keys (public, no token sent). */
  async jwks(): Promise<unknown> {
    const res = await this.fetchFn(
      new Request(`${this.opts.api.replace(/\/$/, '')}/ci/oidc/jwks`),
    );
    if (!res.ok) throw new ApiError(res.status, 'http_error', `JWKS: HTTP ${res.status}`);
    return res.json();
  }

  /** Signed provenance records naming a changeset (#58), as the server stores them. */
  async provenance(cs: string): Promise<unknown[]> {
    return z
      .object({ records: z.array(z.unknown()) })
      .parse(await this.json(`/provenance?cs=${encodeURIComponent(cs)}`)).records;
  }

  /** The forge's published provenance keys (public, no token sent). */
  async provenanceKeys(): Promise<unknown> {
    const res = await this.fetchFn(
      new Request(`${this.opts.api.replace(/\/$/, '')}/.well-known/yag-provenance-keys`),
    );
    if (!res.ok)
      throw new ApiError(res.status, 'http_error', `provenance keys: HTTP ${res.status}`);
    return res.json();
  }

  async history(
    opts: QueryParams<'getHistory'>,
  ): Promise<z.infer<typeof historyResultSchema>> {
    const params = new URLSearchParams();
    if (opts.cs) params.set('cs', opts.cs);
    if (opts.path) params.set('path', opts.path);
    if (opts.limit) params.set('limit', String(opts.limit));
    return historyResultSchema.parse(await this.json(`/history?${params.toString()}`));
  }
}
