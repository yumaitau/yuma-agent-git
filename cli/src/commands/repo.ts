import type { Command } from 'commander';
import { z } from 'zod';
import { forgeFor, type Deps } from '../forge.js';

/**
 * `yag repo view` and `yag repo clone`, like `gh repo …` (issue #74). Clone
 * runs plain `git clone` against the forge's smart HTTP endpoint; run
 * `yag auth setup-git` once so git asks yag for the token.
 */

const repoSchema = z.object({
  full_name: z.string(),
  private: z.boolean(),
  default_branch: z.string(),
  html_url: z.string(),
  clone_url: z.string(),
});

export function registerRepo(program: Command, deps: Deps): void {
  const repo = program.command('repo').description('Repositories, like gh repo');

  repo
    .command('view')
    .argument('[owner/name]', 'repository (default: this checkout)')
    .action(async (slug: string | undefined) => {
      const forge = await forgeFor(deps, { repo: slug });
      const r = repoSchema.parse(await forge.gh('GET', ''));
      deps.out(r.full_name);
      deps.out(
        `${r.private ? 'private' : 'public'} • default branch ${r.default_branch}`,
      );
      deps.out(r.html_url);
    });

  repo
    .command('clone')
    .argument('<owner/name>')
    .argument('[dir]', 'directory (default: the repository name)')
    .action(async (slug: string, dir: string | undefined) => {
      const api = deps.env.YAG_API;
      if (!api)
        throw new Error(
          'Set YAG_API to the forge URL, for example https://forge.example',
        );
      const url = `${api.replace(/\/$/, '')}/${slug}.git`;
      await deps.git(['clone', url, ...(dir ? [dir] : [])], deps.cwd);
      deps.out(`Cloned ${slug}`);
    });
}
