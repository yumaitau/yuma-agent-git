#!/usr/bin/env node
import { Command } from 'commander';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { YagApi } from './api.js';
import { ObjectCache } from './cache.js';
import { checkout } from './checkout.js';
import { loadConfig, saveConfig } from './config.js';
import { commit, status } from './workcopy.js';

/**
 * `yag` — thin client for yuma-agent-git. Sparse by construction: it fetches
 * only the objects it wants, verifies every content address, and keeps a
 * bounded LRU cache so checkouts resume for free.
 */

function cacheRoot(): string {
  return process.env.YAG_CACHE_DIR ?? join(homedir(), '.yag', 'objects');
}

async function client(dir = process.cwd()): Promise<{ api: YagApi; cache: ObjectCache }> {
  const config = await loadConfig(dir);
  const token = process.env.YAG_TOKEN ?? config.token;
  return {
    api: new YagApi({ api: config.api, repo: config.repo, token }),
    cache: new ObjectCache(cacheRoot()),
  };
}

function author(): { name: string; email: string } {
  return {
    name: process.env.YAG_AUTHOR_NAME ?? 'yag',
    email: process.env.YAG_AUTHOR_EMAIL ?? 'yag@localhost',
  };
}

const program = new Command();

program
  .name('yag')
  .description('Thin client for yuma-agent-git (sparse checkout, object cache)')
  .version('0.1.0');

program
  .command('init')
  .argument('<dir>', 'working directory')
  .requiredOption('--repo <slug>', 'repository slug (owner/name)')
  .requiredOption('--api <url>', 'API base URL')
  .option('--token <token>', 'bearer token (or set YAG_TOKEN)')
  .action(async (dir: string, opts: { repo: string; api: string; token?: string }) => {
    await saveConfig(dir, { api: opts.api, repo: opts.repo, token: opts.token });
    console.log(`initialized ${dir}/.yag for ${opts.repo}`);
  });

program
  .command('checkout')
  .argument('<rev>', 'revision: changeset id, ref:main, or a ref name')
  .option('--path <prefix...>', 'sparse prefixes (default: everything)')
  .action(async (rev: string, opts: { path?: string[] }) => {
    const dir = process.cwd();
    const { api, cache } = await client(dir);
    const result = await checkout({
      dir,
      rev,
      prefixes: opts.path ?? [],
      api,
      cache,
      onProgress: (m) => console.error(`yag: ${m}`),
    });
    console.log(`checked out ${result.files.length} files at ${result.cs}`);
  });

program.command('status').action(async () => {
  const st = await status(process.cwd());
  for (const path of st.modified) console.log(`modified: ${path}`);
  for (const path of st.deleted) console.log(`deleted:  ${path}`);
  for (const path of st.untracked) console.log(`untracked:${path}`);
  console.log(
    `${st.modified.length} modified, ${st.deleted.length} deleted, ${st.untracked.length} untracked`,
  );
});

program
  .command('commit')
  .requiredOption('-m, --message <message>', 'commit message')
  .option('--ref <name>', 'CAS-move this ref to the new changeset (e.g. main)')
  .action(async (opts: { message: string; ref?: string }) => {
    const dir = process.cwd();
    const { api } = await client(dir);
    const outcome = await commit({
      dir,
      api,
      message: opts.message,
      author: author(),
      ref: opts.ref,
    });
    if (outcome.stale) {
      console.error(
        `stale ref ${outcome.ref}: expected ${outcome.stale.expected ?? '(none)'}, actual ${outcome.stale.actual ?? '(none)'}`,
      );
      console.error('rebase via `yag checkout` and retry');
      process.exitCode = 3;
      return;
    }
    console.log(
      outcome.refMoved
        ? `landed ${outcome.id} on ${outcome.ref}`
        : `created ${outcome.id}`,
    );
  });

program
  .command('diff')
  .argument('[rev]', 'revision to compare against', 'ref:main')
  .action(async (rev: string) => {
    const dir = process.cwd();
    const { api } = await client(dir);
    const { loadState } = await import('./config.js');
    const state = await loadState(dir);
    const diff = await api.diff(state.cs, rev);
    for (const text of diff.texts ?? []) {
      console.log(`--- ${text.path}${text.side ? ` (${text.side})` : ''}`);
      console.log(text.unified);
    }
    for (const file of diff.files) {
      const marker = file.kind === 'add' ? 'A' : file.kind === 'del' ? 'D' : 'M';
      console.log(`${marker} ${file.path}${file.side ? ` (${file.side})` : ''}`);
    }
  });

program
  .command('log')
  .option('--path <path>', 'only changesets touching this path')
  .option('--limit <n>', 'max entries', '20')
  .action(async (opts: { path?: string; limit: string }) => {
    const dir = process.cwd();
    const { api } = await client(dir);
    const { loadState } = await import('./config.js');
    const state = await loadState(dir);
    const history = await api.history({
      cs: state.cs,
      path: opts.path,
      limit: Number(opts.limit) || 20,
    });
    for (const cs of history.changesets) {
      const date = new Date(cs.created_at).toISOString();
      console.log(`${cs.id.slice(0, 8)} ${date} ${cs.message.split('\n')[0]}`);
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`yag: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
