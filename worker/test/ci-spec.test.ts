import { describe, expect, it } from 'vitest';
import { globMatch, nextRun, parseSpec } from '../src/ci/spec';

const PATH = '.yuma/pipelines/ci.yml';
const THREE_JOBS = `name: ci
on:
  push:
    branches: [main]
  pull_request:
jobs:
  lint:
    steps:
      - run: npm run lint
  test:
    matrix:
      node: [20, 22]
    steps:
      - name: Node version
        run: npx -y node@\${{ matrix.node }} --version
      - run: npm test
  build:
    needs: [lint, test]
    timeout_seconds: 120
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: ci
    steps:
      - run: npm run build
`;

describe('pipeline spec v2', () => {
  it('expands a matrix and keeps needs as job names', () => {
    const file = parseSpec(PATH, THREE_JOBS);
    expect(file.errors).toBeUndefined();
    const jobs = file.pipeline!.jobs;
    expect(jobs.map((j) => j.key)).toEqual(['lint', 'test (20)', 'test (22)', 'build']);
    expect(jobs[1]!.commands[0]).toBe('npx -y node@20 --version');
    expect(jobs[2]!.commands[0]).toBe('npx -y node@22 --version');
    expect(jobs[3]).toMatchObject({
      needs: ['lint', 'test'],
      timeout_seconds: 120,
      services: [
        { name: 'postgres', image: 'postgres:16', env: { POSTGRES_PASSWORD: 'ci' } },
      ],
    });
    expect(file.pipeline!.on).toEqual({
      push: { branches: ['main'] },
      pull_request: null,
    });
  });

  it('accepts the short trigger forms', () => {
    const file = parseSpec(
      PATH,
      'on: [push, manual]\njobs:\n  a:\n    steps: [{run: "true"}]\n',
    );
    expect(file.pipeline?.on).toEqual({ push: null, manual: null });
  });

  it('reports YAML syntax errors with line numbers', () => {
    const file = parseSpec(PATH, 'on: push\njobs:\n  a:\n    steps: [\n  b: 1\n');
    expect(file.pipeline).toBeUndefined();
    expect(file.errors![0]!.line).toBeGreaterThanOrEqual(4);
    expect(file.errors![0]!.message.length).toBeGreaterThan(0);
  });

  it('points schema errors at the offending line', () => {
    const file = parseSpec(
      PATH,
      [
        'on: push', // 1
        'jobs:', // 2
        '  build:', // 3
        '    needs: [tset]', // 4
        '    steps:', // 5
        '      - run: echo ${{ secrets.TOKEN }}', // 6
        '  deploy:', // 7
        '    runs_on: mac', // 8
        '    steps: []', // 9
      ].join('\n'),
    );
    const byLine = Object.fromEntries(file.errors!.map((e) => [e.line, e.message]));
    expect(byLine[4]).toBe('jobs.build.needs.0: Unknown job "tset"');
    expect(byLine[6]).toContain('Unsupported expression "secrets.TOKEN"');
    expect(byLine[8]).toMatch(/runs_on/);
    expect(byLine[9]).toMatch(/^jobs\.deploy\.steps:/);
  });

  it('rejects cycles, oversized matrices and unknown time zones', () => {
    const cycle = parseSpec(
      PATH,
      'on: push\njobs:\n  a:\n    needs: b\n    steps: [{run: x}]\n  b:\n    needs: a\n    steps: [{run: x}]\n',
    );
    expect(cycle.errors!.map((e) => e.message)).toContain(
      'jobs.a.needs: Job needs form a cycle',
    );
    const big = parseSpec(
      PATH,
      'on: push\njobs:\n  a:\n    matrix: {x: [1,2,3], y: [1,2,3]}\n    steps: [{run: x}]\n',
    );
    expect(big.errors![0]).toMatchObject({ line: 4 });
    const zone = parseSpec(
      PATH,
      'on:\n  schedule:\n    - cron: "0 3 * * *"\n      timezone: Mars/Olympus\njobs:\n  a:\n    steps: [{run: x}]\n',
    );
    expect(zone.errors![0]).toMatchObject({ line: 4 });
    const cron = parseSpec(
      PATH,
      'on:\n  schedule:\n    - cron: "0 0 3 * * *"\njobs:\n  a:\n    steps: [{run: x}]\n',
    );
    expect(cron.errors![0]!.message).toContain('five-field cron');
  });

  it('matches branch and path globs', () => {
    expect(globMatch('release/*', 'release/1.2')).toBe(true);
    expect(globMatch('release/*', 'release/1/2')).toBe(false);
    expect(globMatch('src/**', 'src/a/b.ts')).toBe(true);
    expect(globMatch('**/*.md', 'README.md')).toBe(true);
    expect(globMatch('docs/**/*.md', 'docs/a/b/c.md')).toBe(true);
    expect(globMatch('v1.?', 'v1.x')).toBe(true);
    expect(globMatch('v1.?', 'v1x2')).toBe(false);
  });

  it('computes the next schedule time in UTC and Australia/Sydney', () => {
    const at = Date.UTC(2026, 9, 16, 12, 3, 20);
    expect(nextRun('*/5 * * * *', 'UTC', at)).toBe(Date.UTC(2026, 9, 16, 12, 5));
    // 03:00 AEDT (UTC+11) is 16:00 UTC the day before.
    expect(nextRun('0 3 * * *', 'Australia/Sydney', at)).toBe(Date.UTC(2026, 9, 16, 16));
    // 03:00 AEST (UTC+10) in winter.
    expect(nextRun('0 3 * * *', 'Australia/Sydney', Date.UTC(2026, 5, 1))).toBe(
      Date.UTC(2026, 5, 1, 17),
    );
    // 02:30 does not exist on 4 October 2026 in Sydney; the next one is a day later.
    expect(nextRun('30 2 * * *', 'Australia/Sydney', Date.UTC(2026, 9, 3, 15))).toBe(
      Date.UTC(2026, 9, 4, 15, 30),
    );
  });
});
