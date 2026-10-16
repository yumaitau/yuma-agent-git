import type { Command } from 'commander';
import { z } from 'zod';
import { Forge, resolveLocation, type Deps } from '../forge.js';

/**
 * `yag auth …`, like `gh auth …` (issue #74): keep a forge token per host in
 * the OS keychain where available (see credentials.ts) and hand it to plain
 * `git` as a credential helper.
 */

/** `forge.example`, `https://forge.example/x` → `https://forge.example`. */
export function originOf(hostname: string): string {
  return new URL(/^https?:\/\//.test(hostname) ? hostname : `https://${hostname}`).origin;
}

async function hostOf(deps: Deps, hostname?: string): Promise<string> {
  if (hostname) return originOf(hostname);
  if (deps.env.YAG_API) return originOf(deps.env.YAG_API);
  return (await resolveLocation(deps)).api;
}

/** git credential protocol: `key=value` lines. */
export function parseCredentialInput(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1).trim();
  }
  return out;
}

const userSchema = z.object({ login: z.string() });

export function registerAuth(program: Command, deps: Deps): void {
  const auth = program.command('auth').description('Sign in to a forge, like gh auth');
  const hostOption = (cmd: Command) =>
    cmd.option('-h, --hostname <host>', 'forge host (default: YAG_API or this checkout)');

  hostOption(
    auth.command('login').option('--with-token', 'read an API token from standard input'),
  ).action(async (opts: { hostname?: string; withToken?: boolean }) => {
    const origin = await hostOf(deps, opts.hostname);
    if (!opts.withToken)
      throw new Error(
        `Browser device login is not available on this forge yet. Create an API token in the dashboard Settings at ${origin}, then run: yag auth login --hostname ${new URL(origin).host} --with-token < token.txt`,
      );
    const token = (await deps.stdin()).trim();
    if (token === '') throw new Error('No token on standard input');
    const forge = new Forge({ api: origin, repo: '', token }, deps.fetch);
    const res = await forge.raw('GET', '/api/github/v3/user');
    if (!res.ok) throw new Error(`The forge refused the token: HTTP ${res.status}`);
    const user = userSchema.parse(await res.json());
    const store = await deps.store();
    await store.set(new URL(origin).host, token);
    deps.out(
      `Logged in to ${new URL(origin).host} as ${user.login} (token kept in the ${store.kind === 'keychain' ? 'OS keychain' : 'yag hosts file'})`,
    );
  });

  hostOption(auth.command('status')).action(async (opts: { hostname?: string }) => {
    const origin = await hostOf(deps, opts.hostname);
    const host = new URL(origin).host;
    const token = deps.env.YAG_TOKEN ?? (await (await deps.store()).get(host));
    if (!token) {
      deps.err(`Not logged in to ${host}. Run yag auth login.`);
      return deps.exit(1);
    }
    const res = await new Forge({ api: origin, repo: '', token }, deps.fetch).raw(
      'GET',
      '/api/github/v3/user',
    );
    if (!res.ok) {
      deps.err(`${host}: the stored token is not valid (HTTP ${res.status})`);
      return deps.exit(1);
    }
    deps.out(`Logged in to ${host} as ${userSchema.parse(await res.json()).login}`);
  });

  hostOption(auth.command('logout')).action(async (opts: { hostname?: string }) => {
    const host = new URL(await hostOf(deps, opts.hostname)).host;
    await (await deps.store()).delete(host);
    deps.out(`Logged out of ${host}`);
  });

  hostOption(auth.command('token').description('Print the token for the host')).action(
    async (opts: { hostname?: string }) => {
      const host = new URL(await hostOf(deps, opts.hostname)).host;
      const token = deps.env.YAG_TOKEN ?? (await (await deps.store()).get(host));
      if (!token) {
        deps.err(`Not logged in to ${host}`);
        return deps.exit(1);
      }
      deps.out(token);
    },
  );

  auth
    .command('git-credential')
    .description(
      'Git credential helper: git config credential.helper "!yag auth git-credential"',
    )
    .argument('<operation>', 'get, store or erase')
    .action(async (operation: string) => {
      // store and erase are no-ops: yag auth login owns the token
      if (operation !== 'get') return;
      const input = parseCredentialInput(await deps.stdin());
      if (!input.host || (input.protocol && !/^https?$/.test(input.protocol))) return;
      const token = await (await deps.store()).get(input.host);
      if (!token) return;
      deps.out('username=yag');
      deps.out(`password=${token}`);
    });

  hostOption(
    auth.command('setup-git').description('Make git use yag for this forge host'),
  ).action(async (opts: { hostname?: string }) => {
    const origin = await hostOf(deps, opts.hostname);
    const key = `credential.${origin}.helper`;
    // an empty helper first resets helpers inherited from other config files
    await deps.git(['config', '--global', '--replace-all', key, ''], deps.cwd);
    await deps.git(
      ['config', '--global', '--add', key, '!yag auth git-credential'],
      deps.cwd,
    );
    deps.out(`git now asks yag for ${origin} credentials`);
  });
}
