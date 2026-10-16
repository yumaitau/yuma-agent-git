import { execFile } from 'node:child_process';
import { ApiError } from './api.js';
import { loadConfig } from './config.js';
import type { CredentialStore } from './credentials.js';

/**
 * Shared plumbing for the gh-style commands (issue #74): which forge and
 * repository a command talks to, the token it sends, and a small client for
 * the GitHub compatible API (`/api/github/v3`) and the native `/api/v1`.
 */

export interface Deps {
  fetch: typeof fetch;
  out: (line: string) => void;
  err: (line: string) => void;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** `git <args>` in `cwd`; resolves with stdout, rejects on a non-zero exit. */
  git: (args: string[], cwd: string) => Promise<string>;
  store: () => Promise<CredentialStore>;
  stdin: () => Promise<string>;
  /** Set the process exit code (gh's: 1 failure, 8 checks pending). */
  exit: (code: number) => void;
}

export const runGit = (args: string[], cwd: string): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8' }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout),
    );
  });

export interface Target {
  /** Forge origin, for example `https://forge.example`. */
  api: string;
  /** `owner/name`. */
  repo: string;
  token?: string;
}

/** `https://host/owner/name(.git)` → forge origin and slug; null for other remotes. */
export function parseRemote(url: string): { api: string; repo: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const match = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(parsed.pathname);
  if (!match) return null;
  return { api: parsed.origin, repo: `${match[1]}/${match[2]}` };
}

/**
 * The forge and repository for a command: `--repo`/`YAG_API` first, then a
 * `yag` working copy (`.yag/config.json`), then the `origin` remote of a
 * plain Git checkout.
 */
export async function resolveLocation(
  deps: Deps,
  opts: { repo?: string; remote?: string } = {},
): Promise<Target> {
  let api = deps.env.YAG_API;
  let repo = opts.repo;
  let token: string | undefined;
  const config = await loadConfig(deps.cwd).catch(() => null);
  if (config) {
    api ??= config.api;
    repo ??= config.repo;
    token = config.token;
  } else {
    const url = await deps
      .git(['remote', 'get-url', opts.remote ?? 'origin'], deps.cwd)
      .catch(() => '');
    const remote = parseRemote(url.trim());
    if (remote) {
      api ??= remote.api;
      repo ??= remote.repo;
    }
  }
  if (!api || !repo)
    throw new Error(
      'No forge repository here: run inside a yag or Git checkout of the forge, or pass --repo owner/name with YAG_API set',
    );
  return { api: api.replace(/\/$/, ''), repo, token };
}

/**
 * `resolveLocation` plus the token: `YAG_TOKEN`, the working copy's, or the
 * one `yag auth login` stored for the host.
 */
export async function resolveTarget(
  deps: Deps,
  opts: { repo?: string; remote?: string } = {},
): Promise<Target> {
  const { api, repo, token } = await resolveLocation(deps, opts);
  const stored = async () => (await deps.store()).get(new URL(api).host);
  return {
    api,
    repo,
    token: deps.env.YAG_TOKEN ?? token ?? (await stored()) ?? undefined,
  };
}

/** A JSON client for one repository on one forge. */
export class Forge {
  constructor(
    readonly target: Target,
    private readonly fetchFn: typeof fetch,
  ) {}

  /** Any forge path (`/api/...`); returns the raw response, errors included. */
  async raw(method: string, path: string, body?: unknown): Promise<Response> {
    const headers = new Headers({ accept: 'application/json' });
    if (this.target.token) headers.set('authorization', `Bearer ${this.target.token}`);
    if (body !== undefined) headers.set('content-type', 'application/json');
    return this.fetchFn(
      new Request(`${this.target.api}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  }

  private async json(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.raw(method, path, body);
    const text = await res.text();
    const data: unknown = text === '' ? null : JSON.parse(text);
    if (!res.ok) {
      const error = (data as { error?: { code?: string; message?: string } } | null)
        ?.error;
      let message = error?.message ?? `HTTP ${res.status}`;
      if (res.status === 401 && !this.target.token)
        message += ' (run yag auth login, or set YAG_TOKEN)';
      throw new ApiError(res.status, error?.code ?? 'http_error', message, data);
    }
    return data;
  }

  /** GitHub compatible API, relative to `/api/github/v3/repos/<owner>/<name>`. */
  gh(method: string, path: string, body?: unknown): Promise<unknown> {
    return this.json(method, `/api/github/v3/repos/${this.target.repo}${path}`, body);
  }

  /** Native API, relative to `/api/v1/repos/<owner>/<name>`. */
  native(method: string, path: string, body?: unknown): Promise<unknown> {
    return this.json(method, `/api/v1/repos/${this.target.repo}${path}`, body);
  }
}

export async function forgeFor(deps: Deps, opts: { repo?: string } = {}): Promise<Forge> {
  return new Forge(await resolveTarget(deps, opts), deps.fetch);
}
