import { z } from 'zod';

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
      throw new ApiError(res.status, code, message, body);
    }
    return res;
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.request(path, init);
    return (await res.json()) as T;
  }

  async checkoutInfo(cs: string): Promise<z.infer<typeof checkoutInfoSchema>> {
    return checkoutInfoSchema.parse(
      await this.json(`/checkout-info?cs=${encodeURIComponent(cs)}`),
    );
  }

  async fetchObjects(body: {
    trees?: string[];
    blobs?: string[];
    blob_encoding?: 'zstd' | 'identity';
  }): Promise<FetchObjectsResult> {
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

  async createChangeset(body: {
    first_parent: string | null;
    message: string;
    author: { name: string; email: string } | { agent: string };
    changes: unknown[];
  }): Promise<z.infer<typeof commitResultSchema>> {
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
    body: { from: string | null; to: string; force?: boolean },
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

  async history(opts: {
    cs?: string;
    path?: string;
    limit?: number;
  }): Promise<z.infer<typeof historyResultSchema>> {
    const params = new URLSearchParams();
    if (opts.cs) params.set('cs', opts.cs);
    if (opts.path) params.set('path', opts.path);
    if (opts.limit) params.set('limit', String(opts.limit));
    return historyResultSchema.parse(await this.json(`/history?${params.toString()}`));
  }
}
