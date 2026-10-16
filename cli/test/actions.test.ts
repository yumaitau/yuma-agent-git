import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkWorkflows,
  formatReport,
  readWorkflows,
  type ActionsReport,
} from '../src/actions.js';

const REPORT: ActionsReport = {
  summary: { supported: 1, translated: 0, unsupported: 1 },
  workflows: [
    {
      path: '.github/workflows/lint.yml',
      name: 'Lint',
      status: 'supported',
      findings: [],
      pipeline: 'name: Lint\n',
    },
    {
      path: '.github/workflows/scan.yml',
      name: 'Scan',
      status: 'unsupported',
      findings: [
        {
          status: 'unsupported',
          line: 9,
          message: 'No built-in equivalent for aquasecurity/trivy-action',
        },
      ],
      pipeline: null,
    },
  ],
};

async function checkout(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'yag-actions-'));
  await mkdir(join(dir, '.github', 'workflows'), { recursive: true });
  await writeFile(join(dir, '.github', 'workflows', 'scan.yaml'), 'on: pull_request\n');
  await writeFile(join(dir, '.github', 'workflows', 'lint.yml'), 'on: push\n');
  await writeFile(join(dir, '.github', 'workflows', 'notes.md'), 'ignored');
  return dir;
}

function fake(
  seen: { url: string; init?: RequestInit }[],
  status = 200,
  body: unknown = REPORT,
) {
  return (async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

describe('yag actions check', () => {
  it('reads local workflow files by name', async () => {
    const dir = await checkout();
    expect(await readWorkflows(dir)).toEqual([
      { path: '.github/workflows/lint.yml', content: 'on: push\n' },
      { path: '.github/workflows/scan.yaml', content: 'on: pull_request\n' },
    ]);
    expect(await readWorkflows(join(dir, 'missing'))).toEqual([]);
  });

  it('sends local workflows to the server translator', async () => {
    const dir = await checkout();
    const seen: { url: string; init?: RequestInit }[] = [];
    const report = await checkWorkflows({
      api: 'https://forge.example/',
      token: 'yag_x',
      dir,
      fetch: fake(seen),
    });
    expect(seen[0]!.url).toBe('https://forge.example/api/v1/ci/actions/check');
    expect(new Headers(seen[0]!.init!.headers).get('authorization')).toBe('Bearer yag_x');
    expect(JSON.parse(String(seen[0]!.init!.body)).files).toHaveLength(2);
    expect(formatReport(report)).toEqual([
      'supported   .github/workflows/lint.yml',
      'unsupported .github/workflows/scan.yml',
      '  .github/workflows/scan.yml:9: unsupported: No built-in equivalent for aquasecurity/trivy-action',
      '1 supported, 0 translated, 1 unsupported',
    ]);
    await expect(
      checkWorkflows({ api: 'https://f', dir: join(dir, 'missing'), fetch: fake(seen) }),
    ).rejects.toThrow('no workflow files');
  });

  it("reads a repository's report and surfaces the error envelope", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    await checkWorkflows({
      api: 'https://forge.example',
      repo: 'acme/app',
      head: 'ref:release',
      fetch: fake(seen),
    });
    expect(seen[0]!.url).toBe(
      'https://forge.example/api/v1/repos/acme/app/ci/actions?head=ref%3Arelease',
    );
    await expect(
      checkWorkflows({
        api: 'https://f',
        repo: 'acme/app',
        fetch: fake(seen, 404, {
          error: { code: 'repo_not_found', message: 'Repository not found' },
        }),
      }),
    ).rejects.toThrow('repo_not_found: Repository not found');
  });
});
