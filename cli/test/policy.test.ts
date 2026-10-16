import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatResults, loadCases, testPolicy } from '../src/policy.js';

const allow = { name: 'readme', input: { action: 'push', files: [] }, expect: 'allow' };
const deny = {
  name: 'force',
  input: { action: 'push', force_push: true },
  expect: 'deny',
};

async function fixtures(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'yag-policy-'));
  await mkdir(join(dir, 'cases'));
  await writeFile(join(dir, 'cases', 'b.json'), JSON.stringify([deny]));
  await writeFile(join(dir, 'cases', 'a.json'), JSON.stringify([allow]));
  await writeFile(join(dir, 'cases', 'notes.txt'), 'ignored');
  await writeFile(join(dir, 'policy.json'), JSON.stringify({ version: 1, rules: [] }));
  return dir;
}

describe('yag policy test', () => {
  it('reads cases from a directory in name order', async () => {
    const dir = await fixtures();
    expect(await loadCases(join(dir, 'cases'))).toEqual([allow, deny]);
    await expect(loadCases(join(dir, 'policy.json'))).rejects.toThrow(
      /expected an array/,
    );
  });

  it('posts the policy and cases and reports failures', async () => {
    const dir = await fixtures();
    const seen: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(
        JSON.stringify({
          passed: 1,
          failed: 1,
          results: [
            {
              name: 'readme',
              expect: 'allow',
              outcome: 'allow',
              pass: true,
              matches: [],
            },
            { name: 'force', expect: 'deny', outcome: 'allow', pass: false, matches: [] },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const result = await testPolicy({
      api: 'https://forge.example/',
      token: 'yag_x',
      policy: join(dir, 'policy.json'),
      fixtures: join(dir, 'cases'),
      fetch: fake,
    });
    expect(seen[0]!.url).toBe('https://forge.example/api/v1/policy/test');
    expect(new Headers(seen[0]!.init.headers).get('authorization')).toBe('Bearer yag_x');
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({
      cases: [allow, deny],
      policy: { version: 1, rules: [] },
    });
    expect(formatResults(result)).toEqual([
      'ok   readme',
      'FAIL force: expected deny, got allow',
      '1 passed, 1 failed',
    ]);
  });

  it('surfaces the server error envelope', async () => {
    const dir = await fixtures();
    const fake = (async () =>
      new Response(
        JSON.stringify({ error: { code: 'invalid_policy', message: 'rules.0.id: bad' } }),
        { status: 400 },
      )) as unknown as typeof fetch;
    await expect(
      testPolicy({ api: 'https://f', fixtures: join(dir, 'cases'), fetch: fake }),
    ).rejects.toThrow('invalid_policy: rules.0.id: bad');
  });
});
