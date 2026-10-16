import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { Forge, resolveTarget, type Deps } from '../forge.js';

/**
 * `yag api <path>`, like `gh api` (issue #74): a raw authenticated request.
 * A path without a leading `/api/` is taken as GitHub compatible
 * (`/api/github/v3/…`), so `gh api` habits carry over; `{owner}` and
 * `{repo}` expand to the current repository.
 */

/** `-f key=value` (string) and `-F key=value` (number, boolean, null or string). */
export function fieldsOf(raw: string[], typed: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const split = (entry: string): [string, string] => {
    const eq = entry.indexOf('=');
    if (eq < 1) throw new Error(`Field must be key=value: ${entry}`);
    return [entry.slice(0, eq), entry.slice(eq + 1)];
  };
  for (const entry of raw) {
    const [k, v] = split(entry);
    out[k] = v;
  }
  for (const entry of typed) {
    const [k, v] = split(entry);
    out[k] =
      v === 'true'
        ? true
        : v === 'false'
          ? false
          : v === 'null'
            ? null
            : v !== '' && !Number.isNaN(Number(v))
              ? Number(v)
              : v;
  }
  return out;
}

export function apiPath(path: string, repo: string | null): string {
  let p = path.startsWith('/') ? path : `/${path}`;
  if (repo) {
    const [owner, name] = repo.split('/');
    p = p.replaceAll('{owner}', owner!).replaceAll('{repo}', name!);
  }
  return p.startsWith('/api/') ? p : `/api/github/v3${p}`;
}

const collect = (value: string, previous: string[]) => [...previous, value];

export function registerApi(program: Command, deps: Deps): void {
  program
    .command('api')
    .description('Make an authenticated API request, like gh api')
    .argument('<path>', 'path such as repos/{owner}/{repo}/issues, or /api/v1/…')
    .option('-X, --method <method>', 'HTTP method (default GET, or POST with fields)')
    .option('-f, --raw-field <key=value>', 'string field', collect, [])
    .option('-F, --field <key=value>', 'typed field', collect, [])
    .option('--input <file>', 'request body from a file (- for stdin)')
    .option('-i, --include', 'print the status line and headers')
    .option('-R, --repo <owner/name>', 'repository for {owner} and {repo}')
    .action(
      async (
        path: string,
        opts: {
          method?: string;
          rawField: string[];
          field: string[];
          input?: string;
          include?: boolean;
          repo?: string;
        },
      ) => {
        const target = await resolveTarget(deps, opts).catch((err: unknown) => {
          // a host-only request (no {owner}/{repo}) needs only YAG_API
          if (!deps.env.YAG_API || /\{(owner|repo)\}/.test(path)) throw err;
          return {
            api: deps.env.YAG_API.replace(/\/$/, ''),
            repo: '',
            token: deps.env.YAG_TOKEN,
          };
        });
        const forge = new Forge(target, deps.fetch);
        const fields = fieldsOf(opts.rawField, opts.field);
        let body: unknown;
        if (opts.input)
          body = JSON.parse(
            opts.input === '-' ? await deps.stdin() : await readFile(opts.input, 'utf8'),
          );
        else if (Object.keys(fields).length > 0) body = fields;
        const method = (
          opts.method ?? (body === undefined ? 'GET' : 'POST')
        ).toUpperCase();
        let url = apiPath(path, target.repo || null);
        if (method === 'GET' && body !== undefined && !opts.input) {
          const params = new URLSearchParams(
            Object.entries(fields).map(([k, v]): [string, string] => [k, String(v)]),
          );
          url += `${url.includes('?') ? '&' : '?'}${params}`;
          body = undefined;
        }
        const res = await forge.raw(method, url, body);
        if (opts.include) {
          deps.out(`HTTP ${res.status} ${res.statusText}`);
          res.headers.forEach((value, key) => deps.out(`${key}: ${value}`));
          deps.out('');
        }
        const text = await res.text();
        if (text !== '') {
          try {
            deps.out(JSON.stringify(JSON.parse(text), null, 2));
          } catch {
            deps.out(text);
          }
        }
        if (!res.ok) deps.exit(1);
      },
    );
}
