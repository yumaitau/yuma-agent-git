import { describe, expect, it } from 'vitest';
import { analyseTexts, summarise } from '../src/ci/gha/analyse';
import { shellCondition, translateWorkflow } from '../src/ci/gha/translate';
import { parseSpec, type PlannedJob } from '../src/ci/spec';
import nodeCi from './fixtures/gha/node-ci.yml?raw';
import deployAws from './fixtures/gha/deploy-aws.yml?raw';
import dockerGhcr from './fixtures/gha/docker-ghcr.yml?raw';
import nightly from './fixtures/gha/nightly.yml?raw';
import security from './fixtures/gha/security.yml?raw';
import macRelease from './fixtures/gha/mac-release.yml?raw';
import reusable from './fixtures/gha/reusable.yml?raw';
import lint from './fixtures/gha/lint.yml?raw';

/**
 * GitHub Actions compatibility (#49): workflow shapes from the ticket's survey
 * of Yuma repositories, translated into pipeline spec v2 and run through the
 * same parser CI uses.
 */

const FIXTURES: Record<string, string> = {
  'deploy-aws.yml': deployAws,
  'docker-ghcr.yml': dockerGhcr,
  'lint.yml': lint,
  'mac-release.yml': macRelease,
  'nightly.yml': nightly,
  'node-ci.yml': nodeCi,
  'reusable.yml': reusable,
  'security.yml': security,
};
const path = (name: string): string => `.github/workflows/${name}`;

/** The planned jobs of a workflow that translates. */
function jobs(name: string, text = FIXTURES[name]!): PlannedJob[] {
  const { report, file } = translateWorkflow(path(name), text);
  expect(report.pipeline, JSON.stringify(report.findings)).not.toBeNull();
  // what CI runs is the translated YAML read by the pipeline parser
  expect(parseSpec(path(name), report.pipeline!).pipeline).toEqual(file.pipeline);
  return file.pipeline!.jobs;
}

function messages(text: string): string[] {
  return translateWorkflow(path('x.yml'), text).report.findings.map(
    (f) => `${f.line} ${f.status}: ${f.message}`,
  );
}

describe('GitHub Actions compatibility report', () => {
  it('sorts the surveyed workflow shapes into supported, translated and unsupported', () => {
    const { reports, files } = analyseTexts(
      Object.entries(FIXTURES).map(([name, content]) => ({ path: path(name), content })),
    );
    expect(Object.fromEntries(reports.map((r) => [r.path, r.status]))).toEqual({
      [path('deploy-aws.yml')]: 'translated',
      [path('docker-ghcr.yml')]: 'translated',
      [path('lint.yml')]: 'supported',
      [path('mac-release.yml')]: 'unsupported',
      [path('nightly.yml')]: 'translated',
      [path('node-ci.yml')]: 'translated',
      [path('reusable.yml')]: 'unsupported',
      [path('security.yml')]: 'unsupported',
    });
    expect(summarise(reports)).toEqual({ supported: 1, translated: 4, unsupported: 3 });
    // every runnable workflow has a pipeline; the others carry their reasons as errors
    for (const [i, r] of reports.entries()) {
      expect(Boolean(files[i]!.pipeline), r.path).toBe(r.status !== 'unsupported');
      if (r.status === 'unsupported')
        expect(files[i]!.errors!.map((e) => e.message)).toEqual(
          r.findings.filter((f) => f.status === 'unsupported').map((f) => f.message),
        );
    }
    expect(reports.find((r) => r.path === path('lint.yml'))!.findings).toEqual([]);
  });

  it('gives line-numbered reasons for what cannot run', () => {
    const { report } = translateWorkflow(path('security.yml'), security);
    expect(report.findings).toEqual([
      expect.objectContaining({ status: 'translated', line: 6 }),
      {
        status: 'unsupported',
        line: 9,
        message:
          'No built-in equivalent for aquasecurity/trivy-action; replace the step with run steps',
      },
      {
        status: 'unsupported',
        line: 14,
        message:
          'No built-in equivalent for github/codeql-action/upload-sarif; replace the step with run steps',
      },
    ]);
    expect(report.pipeline).toBeNull();
    expect(messages(reusable)).toEqual([
      '2 unsupported: No supported trigger: use push, pull_request, schedule, workflow_dispatch or merge_group',
      '3 translated: pull_request_target is not supported (it runs untrusted code with secrets); the workflow does not run for it',
      '4 translated: The workflow_call event is not supported; the workflow does not run for it',
      '7 unsupported: Reusable workflows are not supported',
    ]);
    expect(messages(macRelease)).toEqual([
      '6 unsupported: GitHub-hosted macos-14 runners do not exist here; register a self-hosted runner and use its labels',
    ]);
    expect(messages('on: push\njobs:\n  a:\n    runs-on: [\n')).toEqual([
      expect.stringMatching(/^\d+ unsupported: /),
    ]);
  });

  it('maps triggers, needs, matrix, env, services, runs-on and timeouts', () => {
    const lintJobs = jobs('lint.yml');
    expect(lintJobs).toMatchObject([
      { key: 'lint', runs_on: ['self-hosted', 'linux'], timeout_seconds: 600 },
    ]);
    const night = translateWorkflow(path('nightly.yml'), nightly).file.pipeline!;
    expect(night.on).toEqual({
      schedule: [{ cron: '0 17 * * *', timezone: 'UTC' }],
      manual: {},
    });
    const [integration] = jobs('nightly.yml');
    expect(integration).toMatchObject({
      timeout_seconds: 480,
      services: [
        { name: 'postgres', image: 'postgres:16', env: { POSTGRES_PASSWORD: 'ci' } },
      ],
    });
    expect(integration!.commands[1]).toBe(
      'set +u +o pipefail\nexport DATABASE_URL="postgres://postgres:ci@localhost:5432/postgres"\nnpm run test:integration',
    );
    const ci = jobs('node-ci.yml');
    expect(ci.map((j) => [j.key, j.runs_on])).toEqual([
      ['test (20)', null],
      ['test (22)', null],
    ]);
    expect(translateWorkflow(path('node-ci.yml'), nodeCi).file.pipeline!.on).toEqual({
      push: { branches: ['main'] },
      pull_request: null,
    });
    const needs = jobs(
      'needs.yml',
      `on: workflow_dispatch
jobs:
  build:
    runs-on: [self-hosted, linux]
    steps: [{ run: make }]
  test:
    needs: build
    runs-on: [self-hosted, linux]
    steps: [{ run: make test }]
`,
    );
    expect(needs.map((j) => [j.key, j.needs])).toEqual([
      ['build', []],
      ['test', ['build']],
    ]);
  });

  it('maps permissions, environment, secrets, vars and the AWS action to job access (#50)', () => {
    const [deploy] = jobs('deploy-aws.yml');
    expect(deploy).toMatchObject({
      environment: 'production',
      permissions: { id_token: 'write', packages: 'none' },
      // aws-region came from the workflow env
      aws: {
        role_arn: 'arn:aws:iam::123456789012:role/deploy',
        region: 'ap-southeast-2',
      },
      secrets: ['SLACK_HOOK', 'SLACK_TOKEN'],
    });
    // checkout and the AWS action need no step; values reach scripts as variables
    expect(deploy!.commands).toEqual([
      'set +u +o pipefail\nexport AWS_REGION="ap-southeast-2"\naws s3 sync dist/ "s3://${SITE_BUCKET}" --delete',
      [
        'set +u +o pipefail',
        'export AWS_REGION="ap-southeast-2"',
        'export HOOK="${SLACK_HOOK}"',
        `if ! { [ "\${GITHUB_REF_TYPE}" = 'tag' ]; }; then echo 'Skipped: the if condition is false'; exit 0; fi`,
        'curl -fsS -X POST -H "Authorization: Bearer ${SLACK_TOKEN}" "$HOOK"',
      ].join('\n'),
    ]);
    // without id-token: write the role cannot be assumed, as on GitHub
    expect(
      messages(`on: push
jobs:
  a:
    runs-on: [self-hosted]
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/deploy
          aws-region: ap-southeast-2
      - run: aws sts get-caller-identity
`),
    ).toContain(
      '3 unsupported: Pipeline limit: jobs.a.aws: aws needs permissions.id_token: write',
    );
    expect(
      messages(`on: push
permissions: write-all
jobs:
  a:
    runs-on: [self-hosted]
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: \${{ secrets.KEY }}
          aws-secret-access-key: \${{ secrets.SECRET }}
          aws-region: ap-southeast-2
`),
    ).toEqual([
      '2 translated: write-all grants only id-token and packages here; jobs get no forge token',
      '8 unsupported: Static AWS keys are not supported: use role-to-assume with OIDC',
    ]);
  });

  it('maps checkout, setup-node, pnpm, cache and artifacts to built-ins', () => {
    const [test20] = jobs('node-ci.yml');
    expect(test20!.commands).toEqual([
      'set +u +o pipefail\nnpm install -g pnpm@9',
      'set +u +o pipefail\npnpm install --frozen-lockfile',
      'set +u +o pipefail\nexport CI="true"\npnpm test',
    ]);
    expect(messages(nodeCi)).toEqual([
      '6 translated: Event types are ignored: the pipeline runs for every activity of this event',
      '7 translated: Concurrency is dropped: only github.workflow, github.ref and github.ref_name groups and a literal cancel-in-progress are supported',
      '14 translated: ubuntu-latest runs on the built-in Linux pool (Debian bookworm with Node.js 22, python3, Docker, git, aws, helm and kubectl)',
      '16 translated: strategy.fail-fast is ignored',
      "25 translated: Uses the runner's Node.js (22 on the built-in pool), not ${{ matrix.node }}",
      '27 translated: Dependency caching is not available yet (#51)',
      '32 translated: Artifacts are not kept yet (#51): the files are discarded when the job ends',
    ]);
    const tools = translateWorkflow(
      path('tools.yml'),
      `on: push
jobs:
  a:
    runs-on: [self-hosted]
    steps:
      - uses: actions/setup-python@v5
        with: { python-version: '3.12' }
      - uses: azure/setup-helm@v4
        with: { version: v3.22.0 }
      - uses: actions/cache@v4
        with: { path: ~/.npm, key: npm }
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - run: helm lint chart
      - uses: actions/download-artifact@v4
`,
    ).report;
    expect(tools.findings.map((f) => `${f.line} ${f.status}: ${f.message}`)).toEqual([
      "6 translated: Uses the runner's python3 (3.11 on the built-in pool, without pip or a python command), not 3.12",
      '10 translated: Caching is not available yet (#51): the job starts without restored files',
      '13 translated: with.fetch-depth is ignored: the runner provides the source',
      '15 unsupported: Artifacts are not passed between jobs yet (#51)',
    ]);
  });

  it('maps the Docker actions to docker login, build and push', () => {
    const [image] = jobs('docker-ghcr.yml');
    expect(image).toMatchObject({
      permissions: { id_token: 'none', packages: 'write' },
      secrets: ['GITHUB_TOKEN'],
    });
    expect(image!.commands).toEqual([
      `set +u +o pipefail\nprintf '%s' "\${GITHUB_TOKEN}" | docker login "ghcr.io" -u "\${GITHUB_ACTOR}" --password-stdin`,
      [
        'set +u +o pipefail',
        'docker build --network=host -t "ghcr.io/yuma/app:${GITHUB_SHA}" -t "ghcr.io/yuma/app:latest" "."',
        'docker push "ghcr.io/yuma/app:${GITHUB_SHA}"',
        'docker push "ghcr.io/yuma/app:latest"',
      ].join('\n'),
    ]);
    expect(messages(dockerGhcr)).toContain(
      '18 translated: No GITHUB_TOKEN is issued: store a forge token as the repository secret GITHUB_TOKEN',
    );
    const ecr = `on: push
env:
  REGISTRY: 123456789012.dkr.ecr.ap-southeast-2.amazonaws.com
permissions:
  id-token: write
jobs:
  a:
    runs-on: [self-hosted]
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/push
          aws-region: ap-southeast-2
      - uses: docker/login-action@v3
        with:
          registry: \${{ env.REGISTRY }}
      - uses: docker/build-push-action@v6
        with:
          file: docker/Dockerfile
          build-args: |
            VERSION=1
          platforms: linux/arm64
`;
    const report = translateWorkflow(path('ecr.yml'), ecr).report;
    expect(report.findings.map((f) => `${f.line} ${f.status}: ${f.message}`)).toEqual([
      expect.stringContaining('10 translated: AWS credentials come from'),
      '22 unsupported: Only linux/amd64 images build here; multi-platform builds need Buildx',
    ]);
    const login = translateWorkflow(
      path('ecr.yml'),
      ecr.replace('linux/arm64', 'linux/amd64'),
    ).file.pipeline!.jobs[0]!.commands;
    expect(login).toEqual([
      'set +u +o pipefail\nexport REGISTRY="123456789012.dkr.ecr.ap-southeast-2.amazonaws.com"\naws ecr get-login-password --region ap-southeast-2 | docker login --username AWS --password-stdin 123456789012.dkr.ecr.ap-southeast-2.amazonaws.com',
      'set +u +o pipefail\nexport REGISTRY="123456789012.dkr.ecr.ap-southeast-2.amazonaws.com"\ndocker build --network=host -f "docker/Dockerfile" --build-arg "VERSION=1" "."',
    ]);
  });

  it('turns expressions into variables and reports the ones with no equivalent', () => {
    const [job] = jobs(
      'expr.yml',
      `on: push
env:
  NAME: yuma
jobs:
  a:
    runs-on: [self-hosted]
    steps:
      - run: echo "\${{ github.repository }} \${{ github.sha }} \${{ env.NAME }} \${{ vars.STAGE }} \${{ github.workflow }}"
`,
    );
    expect(job!.commands).toEqual([
      'set +u +o pipefail\nexport NAME="yuma"\necho "${GITHUB_REPOSITORY} ${GITHUB_SHA} ${NAME} ${STAGE} ${GITHUB_WORKFLOW}"',
    ]);
    expect(
      messages(`on: [push, workflow_dispatch]
jobs:
  a:
    runs-on: [self-hosted]
    steps:
      - run: echo "\${{ github.event.head_commit.message }}"
      - run: echo "\${{ inputs.target }}" >> "$GITHUB_ENV"
`),
    ).toEqual([
      '6 unsupported: Expression ${{ github.event.head_commit.message }} has no equivalent here',
      '7 unsupported: Expression ${{ inputs.target }} has no equivalent here',
      '7 unsupported: Values written to $GITHUB_ENV do not reach later steps',
    ]);
  });

  it('reports unsupported job and matrix features', () => {
    expect(
      messages(`on:
  push:
    paths-ignore: [docs/**]
jobs:
  a:
    runs-on: [self-hosted]
    container: node:22
    strategy:
      matrix:
        os: [linux]
        include:
          - os: mac
    continue-on-error: true
    steps:
      - run: make
        shell: pwsh
`),
    ).toEqual([
      '3 unsupported: paths-ignore is not supported; list what to include',
      '7 unsupported: jobs.<id>.container is not supported',
      '11 unsupported: matrix.include is not supported',
      '13 unsupported: continue-on-error is not supported',
      '16 unsupported: The pwsh shell is not supported; use bash',
    ]);
  });
});

describe('steps', () => {
  it('runs a step with continue-on-error to its first failure, then goes on', () => {
    const [job] = jobs(
      'tolerate.yml',
      `on: push
jobs:
  a:
    runs-on: [self-hosted]
    steps:
      - run: flaky-test
        continue-on-error: true
`,
    );
    expect(job!.commands).toEqual([
      [
        'set +e',
        '(',
        'set -e',
        'set +u +o pipefail',
        'flaky-test',
        ')',
        'code=$?',
        'set -e',
        '[ "$code" -eq 0 ] || echo "Step failed with status $code; continuing (continue-on-error)"',
      ].join('\n'),
    ]);
  });

  it('runs neighbouring steps together in subshells when a job has more than 8', () => {
    const steps = Array.from(
      { length: 10 },
      (_, i) => `      - name: s${i}\n        run: echo ${i}\n`,
    );
    const text = `on: push\njobs:\n  a:\n    runs-on: [self-hosted]\n    steps:\n${steps.join('')}`;
    const [job] = jobs('long.yml', text);
    expect(job!.commands).toEqual([
      Array.from({ length: 10 }, (_, i) => `(\nset +u +o pipefail\necho ${i}\n)`).join(
        '\n',
      ),
    ]);
    expect(messages(text)).toEqual([
      '5 translated: 10 steps run as 1: a pipeline job has 8 steps at most',
    ]);
    // steps that do not fit 2000 characters together stay apart
    const long = 'x'.repeat(600);
    const big = Array.from({ length: 9 }, () => `      - run: echo ${long}\n`).join('');
    const [split] = jobs(
      'big.yml',
      `on: push\njobs:\n  a:\n    runs-on: [self-hosted]\n    steps:\n${big}`,
    );
    expect(split!.commands).toHaveLength(3);
  });
});

describe('if conditions as shell tests', () => {
  const ctx = (expr: string): string => `\${${expr.toUpperCase().replace('.', '_')}}`;
  const cond = (src: string): { test: string; notes: string[] } => {
    const notes: string[] = [];
    return { test: shellCondition(src, ctx, (m) => notes.push(m)), notes };
  };

  it('translates comparisons, logic and string functions', () => {
    expect(cond("github.ref == 'refs/heads/main'").test).toBe(
      `[ "\${GITHUB_REF}" = 'refs/heads/main' ]`,
    );
    expect(cond("startsWith(github.ref, 'refs/tags/v') || !(a.b != 'x')").test).toBe(
      `{ [[ "\${GITHUB_REF}" == 'refs/tags/v'* ]] || ! { { [ "\${A_B}" != 'x' ]; }; }; }`,
    );
    expect(cond("contains(github.ref, 'it''s') && success()").test).toBe(
      `{ [[ "\${GITHUB_REF}" == *'it'\\''s'* ]] && true; }`,
    );
    expect(cond('env.flag').test).toBe(`[ -n "\${ENV_FLAG}" ]`);
  });

  it('notes always(), failure() and cancelled() and rejects the rest', () => {
    expect(cond('always()')).toEqual({
      test: 'true',
      notes: ['always() runs only while earlier steps pass: a failed step ends the job'],
    });
    expect(cond('failure() || cancelled()').test).toBe('{ false || false; }');
    expect(() => cond("hashFiles('x') != ''")).toThrow(
      'hashFiles() is not supported in if',
    );
    expect(() => cond('a.b > 1')).toThrow('> is not supported in if');
    expect(() => cond('a ==')).toThrow('Cannot read the condition');
  });
});
