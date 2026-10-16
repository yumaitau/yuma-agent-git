import { describe, expect, it } from 'vitest';
import {
  formatReport,
  resumeImport,
  startImport,
  waitForImport,
  type ImportReport,
} from '../src/import.js';

const report = (status: string, extra: Partial<ImportReport> = {}): ImportReport => ({
  id: 'job1',
  status,
  resume_at: null,
  error: null,
  ...extra,
});

describe('yag import github', () => {
  it('posts the org import with the bearer token', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ import: report('queued') }), { status: 202 });
    }) as unknown as typeof fetch;
    const started = await startImport(
      { api: 'https://yag.example/', token: 'yag_t', fetch: fake },
      'acme',
      { source: 'github', github_org: 'acme-gh', installation_id: 77, repos: ['app'] },
    );
    expect(started.id).toBe('job1');
    expect(seen[0]?.url).toBe('https://yag.example/api/v1/orgs/acme/imports');
    expect(seen[0]?.init.method).toBe('POST');
    expect((seen[0]?.init.headers as Record<string, string>).authorization).toBe(
      'Bearer yag_t',
    );
    expect(JSON.parse(seen[0]?.init.body as string)).toEqual({
      source: 'github',
      github_org: 'acme-gh',
      installation_id: 77,
      repos: ['app'],
    });
  });

  it('reports the error envelope', async () => {
    const fake = (async () =>
      new Response(
        JSON.stringify({ error: { code: 'unknown_installation', message: 'nope' } }),
        { status: 400 },
      )) as unknown as typeof fetch;
    await expect(
      resumeImport({ api: 'https://yag.example', fetch: fake }, 'acme', 'job1'),
    ).rejects.toThrow('unknown_installation: nope');
  });

  it('waits through a rate-limit pause and prints the per-repo report', async () => {
    const states = [
      report('running'),
      report('rate_limited', { resume_at: Date.UTC(2026, 0, 1) }),
      report('partial', {
        repos: [
          {
            github: 'acme-gh/app',
            repo: 'acme/app',
            status: 'done',
            phase: 'done',
            counts: { issues: 3, pulls: 1 },
            warnings: [{ code: 'diverged' }],
            error: null,
          },
          {
            github: 'acme-gh/big',
            repo: null,
            status: 'failed',
            phase: 'git',
            counts: {},
            warnings: [],
            error: 'too big',
          },
        ],
      }),
    ];
    const fake = (async () =>
      new Response(
        JSON.stringify({ import: states.shift() }),
      )) as unknown as typeof fetch;
    const seen: string[] = [];
    const final = await waitForImport(
      { api: 'https://yag.example', fetch: fake },
      'acme',
      'job1',
      {
        intervalMs: 0,
        onProgress: (r) => seen.push(r.status),
      },
    );
    expect(seen).toEqual(['running', 'rate_limited', 'partial']);
    expect(formatReport(final)).toEqual([
      'import job1: partial',
      '  acme-gh/app -> acme/app done [done] issues=3 pulls=1 warnings=1',
      '  acme-gh/big -> (not created) failed [git] error: too big',
    ]);
    expect(
      formatReport(report('rate_limited', { resume_at: Date.UTC(2026, 0, 1) }))[0],
    ).toBe('import job1: rate_limited until 2026-01-01T00:00:00.000Z');
  });
});
