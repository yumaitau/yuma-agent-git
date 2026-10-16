import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MERGE_FIXTURE,
  MERGE_FIXTURE_SHA1,
} from '../../worker/test/fixtures/git-history';

/**
 * Real-git check for server-side merge commits (issue #42): `git merge
 * --no-ff` over `MERGE_FIXTURE` must record `MERGE_FIXTURE_SHA1`, the SHA-1
 * the worker test (`worker/test/merge.test.ts`) gets from `mergeCommit` for
 * the same inputs. Host Git config is ignored so signing or hooks cannot
 * change the result.
 */

const hasGit = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const enabled = (process.env.CI || process.env.YAG_GIT_SMOKE) && hasGit;

describe.skipIf(!enabled)('git merge --no-ff matches the server-side merge', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'yag-merge-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const git = (args: string[], at = MERGE_FIXTURE.base.at): string => {
    const date = `${Math.floor(at / 1000)} +0000`;
    const res = spawnSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: MERGE_FIXTURE.author.name,
        GIT_AUTHOR_EMAIL: MERGE_FIXTURE.author.email,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_NAME: MERGE_FIXTURE.author.name,
        GIT_COMMITTER_EMAIL: MERGE_FIXTURE.author.email,
        GIT_COMMITTER_DATE: date,
      },
    });
    if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
    return res.stdout.trim();
  };

  const snapshot = async (
    files: Record<string, string>,
    previous: Record<string, string>,
  ): Promise<void> => {
    for (const path of Object.keys(previous))
      if (!(path in files)) await unlink(join(dir, path));
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), content);
    }
    git(['add', '-A']);
  };

  it('records the same commit', { timeout: 60_000 }, async () => {
    const { base, main, feature, merge } = MERGE_FIXTURE;
    git(['init', '-q', '--initial-branch=main']);
    await snapshot(base.files, {});
    git(['commit', '-q', '-m', base.message.trimEnd()], base.at);
    git(['checkout', '-q', '-b', 'feature']);
    await snapshot(feature.files, base.files);
    git(['commit', '-q', '-m', feature.message.trimEnd()], feature.at);
    git(['checkout', '-q', 'main']);
    await snapshot(main.files, base.files);
    git(['commit', '-q', '-m', main.message.trimEnd()], main.at);
    git(['merge', '-q', '--no-ff', '-m', merge.message.trimEnd(), 'feature'], merge.at);

    for (const [path, content] of Object.entries(MERGE_FIXTURE.merged))
      expect(await readFile(join(dir, path), 'utf8')).toBe(content);
    expect(git(['ls-files']).split('\n').sort()).toEqual(
      Object.keys(MERGE_FIXTURE.merged).sort(),
    );
    expect(git(['rev-parse', 'HEAD'])).toBe(MERGE_FIXTURE_SHA1);
  });
});
