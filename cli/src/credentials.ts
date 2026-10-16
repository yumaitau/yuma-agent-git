import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';

/**
 * Where `yag auth login` keeps forge tokens, per host (issue #74). The OS
 * keychain where one is available (macOS `security`, Linux `secret-tool`),
 * else `~/.yag/hosts.json` with mode 0600. `YAG_CREDENTIAL_STORE=file` or
 * `keychain` forces one.
 */
export interface CredentialStore {
  readonly kind: 'keychain' | 'file';
  get(host: string): Promise<string | null>;
  set(host: string, token: string): Promise<void>;
  delete(host: string): Promise<void>;
}

const SERVICE = 'yag';

type Run = (cmd: string, args: string[], input?: string) => Promise<string>;

export const run: Run = (cmd, args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { encoding: 'utf8' }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
    if (input !== undefined) child.stdin?.end(input);
  });

const hostsSchema = z.record(z.string(), z.object({ token: z.string() }));

export function fileStore(path: string): CredentialStore {
  const load = async (): Promise<z.infer<typeof hostsSchema>> => {
    try {
      return hostsSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
  };
  const save = async (hosts: z.infer<typeof hostsSchema>): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(hosts, null, 2)}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
  };
  return {
    kind: 'file',
    get: async (host) => (await load())[host]?.token ?? null,
    set: async (host, token) => save({ ...(await load()), [host]: { token } }),
    delete: async (host) => {
      const hosts = await load();
      delete hosts[host];
      await save(hosts);
    },
  };
}

/** macOS login keychain through `security` (generic password, service `yag`). */
export function macKeychain(exec: Run = run): CredentialStore {
  return {
    kind: 'keychain',
    get: async (host) => {
      try {
        return (
          await exec('security', [
            'find-generic-password',
            '-s',
            SERVICE,
            '-a',
            host,
            '-w',
          ])
        ).trim();
      } catch {
        return null;
      }
    },
    set: async (host, token) => {
      await exec('security', [
        'add-generic-password',
        '-U',
        '-s',
        SERVICE,
        '-a',
        host,
        '-w',
        token,
      ]);
    },
    delete: async (host) => {
      await exec('security', [
        'delete-generic-password',
        '-s',
        SERVICE,
        '-a',
        host,
      ]).catch(() => '');
    },
  };
}

/** Secret Service (GNOME Keyring, KWallet) through `secret-tool`; the token goes on stdin. */
export function secretTool(exec: Run = run): CredentialStore {
  const attrs = (host: string) => ['service', SERVICE, 'host', host];
  return {
    kind: 'keychain',
    get: async (host) => {
      try {
        const out = (await exec('secret-tool', ['lookup', ...attrs(host)])).trim();
        return out === '' ? null : out;
      } catch {
        return null;
      }
    },
    set: async (host, token) => {
      await exec('secret-tool', ['store', `--label=yag ${host}`, ...attrs(host)], token);
    },
    delete: async (host) => {
      await exec('secret-tool', ['clear', ...attrs(host)]).catch(() => '');
    },
  };
}

/** The store for this machine (see CredentialStore). */
export async function defaultStore(
  env: NodeJS.ProcessEnv = process.env,
  exec: Run = run,
  platform: NodeJS.Platform = process.platform,
): Promise<CredentialStore> {
  const file = fileStore(
    join(env.YAG_CONFIG_DIR ?? join(homedir(), '.yag'), 'hosts.json'),
  );
  const forced = env.YAG_CREDENTIAL_STORE;
  if (forced === 'file') return file;
  const available = (tool: string): Promise<boolean> =>
    exec('which', [tool]).then(
      () => true,
      () => false,
    );
  if (platform === 'darwin' && (await available('security'))) return macKeychain(exec);
  if (platform === 'linux' && (await available('secret-tool'))) return secretTool(exec);
  if (forced === 'keychain') throw new Error('No OS keychain found on this machine');
  return file;
}
