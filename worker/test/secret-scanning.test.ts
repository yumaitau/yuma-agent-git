import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { cleanDb, instrumentQueues, loginAs, makeApp, seedSchema } from './helpers';
import type { TestEnv } from './helpers';
import {
  blob,
  commit,
  packOf,
  parseReport,
  pushBody,
  tree,
  ZERO,
  type Obj,
} from './git-helpers';
import { q, q1, run } from '../src/db/client';
import { C, T } from '../src/db/schema';
import { createRepo, getRef, setRef } from '../src/db/repos';
import { createApiToken } from '../src/auth/tokens';
import { commitChanges } from '../src/core/commit';
import { concatBytes, FLUSH, pktLine } from '../src/git/pktline';
import { commitShas } from '../src/git/upload-pack';
import {
  DETECTORS,
  entropy,
  redactDeep,
  redactSecrets,
  scanText,
} from '../src/security/secrets/detectors';
import { runSecretScanSlice } from '../src/security/secrets/history';
import { derivedQueue } from '../src/queues/derived';
import type { DerivedMessage } from '../src/core/derived';
import { executeTool, type ToolCtx } from '../src/agents/tools';
import { newBudget } from '../src/agents/budget';
import { setChatProvider, type ChatResult } from '../src/agents/llm';
import type { Principal } from '../src/auth/principal';

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const app = makeApp(testEnv);
const SLUG = 'acme/vault';
const author = { name: 'Ada', email: 'ada@example.com' };
const b64 = (text: string): string => btoa(text);

/**
 * Fixture secrets are built at run time from a seeded generator, so this file
 * holds no literal secret and pushing the forge's own repo stays clean.
 */
function rand(n: number, alphabet: string, seed: number): string {
  let x = seed;
  let out = '';
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out += alphabet[(x >>> 16) % alphabet.length];
  }
  return out;
}
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const B64 = `${ALNUM}+/`;
const DIGITS = '0123456789';

const AWS_KEY = `AKIA${rand(16, BASE32, 1)}`;
const FIXTURES: Record<string, string> = {
  aws_access_key_id: AWS_KEY,
  aws_secret_access_key: `aws_secret_access_key = ${rand(40, B64, 2)}`,
  github_token: `ghp_${rand(36, ALNUM, 3)}`,
  yag_token: `yag_${rand(40, '0123456789abcdef', 4)}`,
  cloudflare_api_token: `CLOUDFLARE_API_TOKEN=${rand(40, `${ALNUM}_-`, 5)}`,
  cloudflare_global_api_key: `CF_API_KEY: ${rand(37, '0123456789abcdef', 6)}`,
  cloudflare_origin_ca_key: `v1.0-${rand(24, '0123456789abcdef', 7)}-${rand(146, '0123456789abcdef', 8)}`,
  private_key: [
    `-----BEGIN ${'RSA PRIVATE'} KEY-----`,
    rand(64, B64, 9),
    rand(64, B64, 10),
    `-----END ${'RSA PRIVATE'} KEY-----`,
  ].join('\n'),
  slack_token: `xoxb-${rand(12, DIGITS, 11)}-${rand(13, DIGITS, 12)}-${rand(24, ALNUM, 13)}`,
  slack_webhook_url: `https://hooks.slack.com/services/T${rand(8, BASE32, 14)}/B${rand(8, BASE32, 15)}/${rand(24, ALNUM, 16)}`,
  stripe_secret_key: `sk_${'live'}_${rand(24, ALNUM, 17)}`,
  stripe_webhook_secret: `whsec_${rand(32, ALNUM, 18)}`,
  generic_secret: `client_secret = "${rand(32, ALNUM, 19)}"`,
};

describe('detectors', () => {
  it('has a fixture for every detector and finds each one', () => {
    expect(Object.keys(FIXTURES).sort()).toEqual(DETECTORS.map((d) => d.id).sort());
    for (const [id, text] of Object.entries(FIXTURES)) {
      const found = scanText(`line one\n  ${text}\n`);
      expect(
        found.map((f) => f.detector),
        id,
      ).toEqual([id]);
      expect(found[0]).toMatchObject({ line: 2 });
    }
  });

  it('reports line and column of the secret, not its variable name', () => {
    const [found] = scanText(`a\nb\nexport KEY=${AWS_KEY}\n`);
    expect(found).toMatchObject({ line: 3, column: 12, secret: AWS_KEY });
    const [assigned] = scanText(FIXTURES.aws_secret_access_key!);
    expect(assigned!.secret).toHaveLength(40);
  });

  it('ignores documented examples, placeholders and low-entropy values', () => {
    const quiet = [
      'AKIAIOSFODNN7EXAMPLE',
      'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      'password = "changeme_changeme_changeme"',
      'token = "aaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
      'secret = "abcabcabcabcabcabcabcabc"',
      'api_key = "${API_KEY_FROM_THE_ENVIRONMENT}"',
      'token = "<your token goes here please>"',
      `sk_${'test'}_${rand(24, ALNUM, 20)}`,
      `-----BEGIN ${'PRIVATE'} KEY-----\n...\n-----END ${'PRIVATE'} KEY-----`,
      'ghp_short',
    ];
    for (const text of quiet) expect(scanText(text), text).toEqual([]);
    expect(entropy('aaaa')).toBe(0);
    expect(entropy('abcd')).toBe(2);
  });

  it('finds whole private keys, with PEM headers or without an END line', () => {
    const body = rand(64, B64, 21);
    const legacy = [
      `-----BEGIN ${'RSA PRIVATE'} KEY-----`,
      'Proc-Type: 4,ENCRYPTED',
      'DEK-Info: AES-128-CBC,0123456789ABCDEF',
      '',
      body,
      body,
      `-----END ${'RSA PRIVATE'} KEY-----`,
    ].join('\n');
    expect(redactSecrets(`a\n${legacy}\nb`)).toBe('a\n[REDACTED:private_key]\nb');
    const cut = `-----BEGIN ${'OPENSSH PRIVATE'} KEY-----\n${body}\n${body}`;
    expect(redactSecrets(`x\n${cut}`)).toBe('x\n[REDACTED:private_key]');
  });

  it('a token inside a generic assignment is reported once, as itself', () => {
    const found = scanText(`token = "${FIXTURES.github_token}"`);
    expect(found.map((f) => f.detector)).toEqual(['github_token']);
  });

  it('redacts text, nested values and base64 file content', () => {
    expect(redactSecrets(`key ${AWS_KEY} end`)).toBe(
      'key [REDACTED:aws_access_key_id] end',
    );
    const redacted = redactDeep({
      text: `pasted ${FIXTURES.github_token}`,
      list: [FIXTURES.private_key],
      input: { changes: [{ path: 'a.env', content_b64: b64(`KEY=${AWS_KEY}\n`) }] },
      n: 3,
    });
    expect(JSON.stringify(redacted)).not.toContain(AWS_KEY);
    expect(redacted.text).toBe('pasted [REDACTED:github_token]');
    expect(redacted.list).toEqual(['[REDACTED:private_key]']);
    expect(atob(redacted.input.changes[0]!.content_b64)).toBe(
      'KEY=[REDACTED:aws_access_key_id]\n',
    );
    expect(redacted.n).toBe(3);
  });
});

let repoId = '';
let owner: Awaited<ReturnType<typeof loginAs>>;
let writer: Awaited<ReturnType<typeof loginAs>>;

async function basic(userId: string): Promise<string> {
  const token = await createApiToken(dbEnv, userId, { label: 'git' });
  return `Basic ${btoa(`git:${token.raw}`)}`;
}

/** A commit whose root tree holds `files` (path → content). */
async function snapshot(
  parent: string | null,
  files: Record<string, string>,
): Promise<{ objects: Obj[]; head: Obj }> {
  const blobs = await Promise.all(Object.values(files).map((text) => blob(text)));
  const root = await tree(
    Object.keys(files).map((name, i) => ({ name, sha: blobs[i]!.sha })),
  );
  const head = await commit(root.sha, parent ? [parent] : [], 'change\n');
  return { objects: [head, root, ...blobs], head };
}

async function gitPush(
  commands: [string, string, string][],
  objects: Obj[],
  auth: string,
  options: string[] = [],
): Promise<ReturnType<typeof parseReport>> {
  const caps = `report-status side-band-64k${options.length > 0 ? ' push-options' : ''}`;
  const pack = await packOf(objects);
  const body =
    options.length === 0
      ? pushBody(commands, pack, caps)
      : concatBytes([
          ...commands.map(([o, n, r], i) =>
            pktLine(`${o} ${n} ${r}${i === 0 ? `\0${caps}` : ''}\n`),
          ),
          FLUSH,
          ...options.map((o) => pktLine(`${o}\n`)),
          FLUSH,
          pack,
        ]);
  const res = await app(
    new Request(`https://x/${SLUG}.git/git-receive-pack`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-git-receive-pack-request',
        authorization: auth,
      },
      body,
    }),
  );
  expect(res.status).toBe(200);
  return parseReport(new Uint8Array(await res.arrayBuffer()));
}

async function api(
  path: string,
  as: { cookie: string },
  method = 'GET',
  body?: unknown,
): Promise<Response> {
  return app(
    new Request(`https://x/api/v1${path}`, {
      method,
      headers: { cookie: as.cookie, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

/** Every stored row an alert or audit event left, as one string. */
async function storedText(): Promise<string> {
  const alerts = await q(dbEnv, 'SELECT * FROM secret_alerts');
  const audit = await q(dbEnv, 'SELECT target FROM audit_events');
  return JSON.stringify([alerts, audit]);
}

beforeEach(async () => {
  await seedSchema(testEnv);
  await cleanDb(testEnv);
  owner = await loginAs(testEnv, 1, 'ada');
  writer = await loginAs(testEnv, 2, 'bob');
  repoId = (await createRepo(dbEnv, { slug: SLUG, createdBy: owner.userId })).id;
  await run(
    dbEnv,
    `INSERT INTO ${T.repoMembers} (${C.repoMembers.repoId}, ${C.repoMembers.userId}, ${C.repoMembers.role}) VALUES (?, ?, 'write')`,
    [repoId, writer.userId],
  );
});

describe('push protection', () => {
  it('rejects a pushed AWS key with the file and line', async () => {
    const { objects, head } = await snapshot(null, {
      'README.md': 'hello\n',
      'deploy.env': `REGION=ap-southeast-2\nAWS_ACCESS_KEY_ID=${AWS_KEY}\n`,
    });
    const report = await gitPush(
      [[ZERO, head.sha, 'refs/heads/main']],
      objects,
      await basic(writer.userId),
    );
    expect(report.refs['refs/heads/main']).toMatch(
      /^secret_scanning: AWS access key ID at deploy\.env:2 \(commit [0-9a-f]{7}\)/,
    );
    expect(report.messages).toContain('deploy.env:2');
    expect(report.messages).toContain('-o secret-scanning.bypass=');
    expect(await getRef(dbEnv, repoId, 'main')).toBeNull();
    expect(await storedText()).not.toContain(AWS_KEY);
  });

  it('scans only what the push adds', async () => {
    // a secret already in history (imported before scanning) does not block edits
    const seeded = await commitChanges(dbEnv, repoId, {
      first_parent: null,
      message: 'seed',
      author,
      changes: [{ path: 'a.env', op: 'add', content_b64: b64(`KEY=${AWS_KEY}\n`) }],
    });
    await setRef(dbEnv, repoId, 'main', seeded.changeset.id);
    const base = (await commitShas(dbEnv, repoId, [seeded.changeset.id])).get(
      seeded.changeset.id,
    ) as string;
    const next = await snapshot(base, { 'a.env': `KEY=${AWS_KEY}\nMORE=1\n` });
    const ok = await gitPush(
      [[base, next.head.sha, 'refs/heads/main']],
      next.objects,
      await basic(writer.userId),
    );
    expect(ok.refs['refs/heads/main']).toBe('ok');
  });

  it('lets a repository admin bypass with a reason, audited with an alert', async () => {
    const { objects, head } = await snapshot(null, {
      'fixtures.txt': `token: ${FIXTURES.github_token}\n`,
    });
    const refs: [string, string, string][] = [[ZERO, head.sha, 'refs/heads/main']];

    // a write member cannot bypass, and an unknown reason is refused
    const denied = await gitPush(refs, objects, await basic(writer.userId), [
      'secret-scanning.bypass=will_fix',
    ]);
    expect(denied.refs['refs/heads/main']).toContain(
      'only a repository admin can bypass',
    );
    const unknown = await gitPush(refs, objects, await basic(owner.userId), [
      'secret-scanning.bypass=because',
    ]);
    expect(unknown.refs['refs/heads/main']).toContain('unknown bypass reason');

    const report = await gitPush(refs, objects, await basic(owner.userId), [
      'secret-scanning.bypass=will_fix',
      'secret-scanning.comment=rotating today',
    ]);
    expect(report.refs['refs/heads/main']).toBe('ok');
    const alert = await q1<Record<string, unknown>>(dbEnv, 'SELECT * FROM secret_alerts');
    expect(alert).toMatchObject({
      repo_id: repoId,
      detector: 'github_token',
      path: 'fixtures.txt',
      line: 1,
      source: 'push',
      state: 'open',
      bypass_reason: 'will_fix',
      bypass_comment: 'rotating today',
      created_by: owner.userId, // the person behind the token
    });
    expect(alert!.changeset_id).toBe((await getRef(dbEnv, repoId, 'main'))!.head);
    expect(alert!.secret_hash).toMatch(/^[0-9a-f]{64}$/);
    const event = await q1<{ target: string; on_behalf_of: string }>(
      dbEnv,
      "SELECT target, on_behalf_of FROM audit_events WHERE action = 'secret_scanning.bypass'",
    );
    expect(event!.on_behalf_of).toBe(owner.userId);
    expect(JSON.parse(event!.target)).toMatchObject({
      via: 'git-push',
      ref: 'main',
      reason: 'will_fix',
      findings: [{ detector: 'github_token', path: 'fixtures.txt', line: 1 }],
    });
    expect(await storedText()).not.toContain(FIXTURES.github_token);
  });
});

describe('commit RPC', () => {
  const secretChange = (path = 'config.json') => ({
    path,
    op: 'add' as const,
    content_b64: b64(`{\n  "stripe": "${FIXTURES.stripe_secret_key}"\n}\n`),
  });

  it('refuses a commit that adds a secret, with the location', async () => {
    const res = await api(`/repos/${SLUG}/changesets`, writer, 'POST', {
      first_parent: null,
      message: 'add config',
      author,
      changes: [secretChange()],
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error).toMatchObject({
      code: 'secret_detected',
      findings: [{ detector: 'stripe_secret_key', path: 'config.json', line: 2 }],
      bypass_reasons: ['false_positive', 'test_data', 'will_fix'],
    });
    expect(JSON.stringify(body)).not.toContain(FIXTURES.stripe_secret_key);
  });

  it('admins bypass; a false positive stops blocking that secret here', async () => {
    const bypass = { reason: 'false_positive', comment: 'fixture' };
    const forbidden = await api(`/repos/${SLUG}/changesets`, writer, 'POST', {
      first_parent: null,
      message: 'add config',
      author,
      changes: [secretChange()],
      secret_scanning_bypass: bypass,
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({
      error: { code: 'secret_bypass_forbidden' },
    });

    const created = await api(`/repos/${SLUG}/changesets`, owner, 'POST', {
      first_parent: null,
      message: 'add config',
      author,
      changes: [secretChange()],
      secret_scanning_bypass: bypass,
    });
    expect(created.status).toBe(201);
    const { changeset } = (await created.json()) as { changeset: { id: string } };
    expect(await q1(dbEnv, 'SELECT * FROM secret_alerts')).toMatchObject({
      source: 'commit',
      state: 'resolved',
      resolution: 'false_positive',
      changeset_id: changeset.id,
    });
    expect(
      await q1(
        dbEnv,
        "SELECT 1 FROM audit_events WHERE action = 'secret_scanning.bypass'",
      ),
    ).not.toBeNull();

    // dismissed as a false positive: the same value elsewhere is not blocked
    const again = await api(`/repos/${SLUG}/changesets`, writer, 'POST', {
      first_parent: changeset.id,
      message: 'copy config',
      author,
      changes: [secretChange('copy.json')],
    });
    expect(again.status).toBe(201);
    expect(await storedText()).not.toContain(FIXTURES.stripe_secret_key);
  });

  it('the agent commit tool refuses secrets and cannot bypass', async () => {
    const seeded = await commitChanges(dbEnv, repoId, {
      first_parent: null,
      message: 'seed',
      author,
      changes: [{ path: 'a.txt', op: 'add', content_b64: b64('a\n') }],
    });
    const ctx: ToolCtx = {
      repo_id: repoId,
      principal: { kind: 'user', userId: owner.userId } as Principal,
      base_cs: seeded.changeset.id,
      head_cs: seeded.changeset.id,
      budget: newBudget(),
      task_id: 'task-secrets',
    };
    const result = await executeTool(dbEnv, ctx, 'commit', {
      message: 'leak',
      changes: [{ path: 'b.txt', op: 'add', content_b64: b64(FIXTURES.private_key) }],
    });
    expect(result).toMatchObject({
      error: 'secret_detected',
      findings: [{ detector: 'private_key', path: 'b.txt', line: 1 }],
    });
    expect(ctx.head_cs).toBe(seeded.changeset.id);
  });
});

describe('alerts and history scans', () => {
  async function seedLeakyHistory(): Promise<string> {
    const first = await commitChanges(dbEnv, repoId, {
      first_parent: null,
      message: 'one',
      author,
      created_at: 1000,
      changes: [
        {
          path: 'ci.yml',
          op: 'add',
          content_b64: b64(`SLACK=${FIXTURES.slack_token}\n`),
        },
      ],
    });
    const second = await commitChanges(dbEnv, repoId, {
      first_parent: first.changeset.id,
      message: 'two',
      author,
      created_at: 2000,
      changes: [
        { path: 'ci.yml', op: 'mod', content_b64: b64('clean\n') },
        { path: 'b.txt', op: 'add', content_b64: b64(`x\ny\n${FIXTURES.yag_token}\n`) },
      ],
    });
    await setRef(dbEnv, repoId, 'main', second.changeset.id);
    return first.changeset.id;
  }

  it('scans history in slices and raises alerts for old secrets', async () => {
    const first = await seedLeakyHistory();
    const probe = instrumentQueues(testEnv);
    const started = await makeApp(probe.env)(
      new Request(`https://x/api/v1/repos/${SLUG}/secret-scanning/scans`, {
        method: 'POST',
        headers: { cookie: owner.cookie },
      }),
    );
    expect(started.status).toBe(202);
    const { scan } = (await started.json()) as { scan: { id: string; state: string } };
    expect(scan.state).toBe('queued');
    expect(probe.sends).toContainEqual({
      queue: 'DERIVED_QUEUE',
      body: { secret_scan: scan.id },
    });

    // a one-changeset slice leaves work; the queue consumer finishes it
    expect(await runSecretScanSlice(dbEnv, scan.id, 1)).toBe(false);
    const acked: number[] = [];
    await derivedQueue(
      {
        queue: 'derived-data',
        messages: [
          {
            id: 'm0',
            timestamp: new Date(),
            attempts: 1,
            body: { secret_scan: scan.id } as unknown as DerivedMessage,
            ack: () => acked.push(0),
            retry: () => {},
          },
        ],
        ackAll: () => {},
        retryAll: () => {},
      } as unknown as MessageBatch<DerivedMessage>,
      dbEnv,
    );
    expect(acked).toEqual([0]);
    while (!(await runSecretScanSlice(dbEnv, scan.id))) {
      /* the consumer re-queued; drain here */
    }

    const list = await api(`/repos/${SLUG}/secret-scanning/alerts?state=open`, owner);
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      alerts: Record<string, unknown>[];
      scan: Record<string, unknown>;
    };
    expect(body.scan).toMatchObject({ state: 'done', changesets: 2, alerts: 2 });
    expect(body.alerts).toHaveLength(2);
    expect(body.alerts).toContainEqual(
      expect.objectContaining({
        detector: 'slack_token',
        detector_name: 'Slack token',
        path: 'ci.yml',
        line: 1,
        changeset_id: first,
        source: 'history',
      }),
    );
    expect(body.alerts).toContainEqual(
      expect.objectContaining({ detector: 'yag_token', path: 'b.txt', line: 3 }),
    );
    expect(JSON.stringify(body)).not.toContain('secret_hash');
    expect(await storedText()).not.toContain(FIXTURES.slack_token);

    // a second scan does not duplicate alerts
    const rescan = await api(`/repos/${SLUG}/secret-scanning/scans`, owner, 'POST');
    const again = ((await rescan.json()) as { scan: { id: string } }).scan.id;
    while (!(await runSecretScanSlice(dbEnv, again))) {
      /* drain */
    }
    expect(await q(dbEnv, 'SELECT id FROM secret_alerts')).toHaveLength(2);
  });

  it('resolves and reopens alerts, audited; admins only', async () => {
    await seedLeakyHistory();
    const { scan } = (await (
      await api(`/repos/${SLUG}/secret-scanning/scans`, owner, 'POST')
    ).json()) as { scan: { id: string } };
    const id = scan.id;
    while (!(await runSecretScanSlice(dbEnv, id))) {
      /* drain */
    }
    const [alert] = (
      (await (await api(`/repos/${SLUG}/secret-scanning/alerts`, owner)).json()) as {
        alerts: { id: number }[];
      }
    ).alerts;

    expect((await api(`/repos/${SLUG}/secret-scanning/alerts`, writer)).status).toBe(403);
    const stranger = await loginAs(testEnv, 3, 'eve');
    expect((await api(`/repos/${SLUG}/secret-scanning/alerts`, stranger)).status).toBe(
      404,
    );
    expect(
      (
        await api(`/repos/${SLUG}/secret-scanning/alerts/${alert!.id}`, owner, 'PATCH', {
          state: 'resolved',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api(`/repos/${SLUG}/secret-scanning/alerts/999999`, owner, 'PATCH', {
          state: 'open',
        })
      ).status,
    ).toBe(404);

    const resolved = await api(
      `/repos/${SLUG}/secret-scanning/alerts/${alert!.id}`,
      owner,
      'PATCH',
      { state: 'resolved', resolution: 'revoked' },
    );
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toMatchObject({
      alert: { state: 'resolved', resolution: 'revoked', resolved_by: owner.userId },
    });
    const listed = (await (
      await api(`/repos/${SLUG}/secret-scanning/alerts?state=resolved`, owner)
    ).json()) as { alerts: { id: number }[] };
    expect(listed.alerts.map((a) => a.id)).toEqual([alert!.id]);

    const reopened = await api(
      `/repos/${SLUG}/secret-scanning/alerts/${alert!.id}`,
      owner,
      'PATCH',
      { state: 'open' },
    );
    expect(await reopened.json()).toMatchObject({
      alert: { state: 'open', resolution: null, resolved_at: null },
    });
    const events = await q<{ target: string }>(
      dbEnv,
      "SELECT target FROM audit_events WHERE action = 'secret_scanning.alert.update' ORDER BY id",
    );
    expect(events.map((e) => JSON.parse(e.target).state)).toEqual(['resolved', 'open']);
  });
});

describe('transcript redaction', () => {
  afterEach(() => setChatProvider(null));

  it('redacts secrets an agent reads or says before they are stored', async () => {
    const seeded = await commitChanges(dbEnv, repoId, {
      first_parent: null,
      message: 'seed',
      author,
      changes: [{ path: '.env', op: 'add', content_b64: b64(`AWS=${AWS_KEY}\n`) }],
    });
    await setRef(dbEnv, repoId, 'main', seeded.changeset.id);
    const taskId = `task-${crypto.randomUUID()}`;
    await run(
      dbEnv,
      `INSERT INTO ${T.agentTasks} (${C.agentTasks.id}, ${C.agentTasks.repoId}, ${C.agentTasks.kind}, ${C.agentTasks.prompt}, ${C.agentTasks.status}, ${C.agentTasks.baseCs}, ${C.agentTasks.createdBy}, ${C.agentTasks.createdAt}, ${C.agentTasks.updatedAt})
       VALUES (?, ?, 'freeform', 'read the env file', 'queued', ?, ?, ?, ?)`,
      [taskId, repoId, seeded.changeset.id, owner.userId, Date.now(), Date.now()],
    );
    const script: ChatResult[] = [
      { tool_calls: [{ name: 'read_file', arguments: { path: '.env' } }] },
      {
        tool_calls: [
          { name: 'finish', arguments: { summary: `found ${FIXTURES.github_token}` } },
        ],
      },
    ];
    let turn = 0;
    setChatProvider(
      async () => script[Math.min(turn++, script.length - 1)] as ChatResult,
    );
    const stub = testEnv.AGENT.get(testEnv.AGENT.idFromName(taskId)) as unknown as {
      runTask(id: string): Promise<unknown>;
      getStateSnapshot(): Promise<{ transcript: unknown[] }>;
    };
    await stub.runTask(taskId);
    const state = JSON.stringify((await stub.getStateSnapshot()).transcript);
    expect(state).toContain('[REDACTED:aws_access_key_id]');
    expect(state).not.toContain(AWS_KEY);
    expect(state).not.toContain(FIXTURES.github_token);

    const stored = await testEnv.OBJECTS.get(
      `repos/${repoId}/agents/${taskId}/transcript.jsonl`,
    );
    expect(await stored!.text()).not.toContain(AWS_KEY);
  });

  it('redacts older transcripts on the way out', async () => {
    const taskId = `task-${crypto.randomUUID()}`;
    await run(
      dbEnv,
      `INSERT INTO ${T.agentTasks} (${C.agentTasks.id}, ${C.agentTasks.repoId}, ${C.agentTasks.kind}, ${C.agentTasks.prompt}, ${C.agentTasks.status}, ${C.agentTasks.createdBy}, ${C.agentTasks.createdAt}, ${C.agentTasks.updatedAt})
       VALUES (?, ?, 'freeform', 'x', 'landed', ?, ?, ?)`,
      [taskId, repoId, owner.userId, Date.now(), Date.now()],
    );
    await testEnv.OBJECTS.put(
      `repos/${repoId}/agents/${taskId}/transcript.jsonl`,
      `${JSON.stringify({ t: 1, kind: 'llm', text: `key ${AWS_KEY}` })}\n`,
    );
    const res = await api(`/agents/tasks/${taskId}/transcript`, owner);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      entries: [{ t: 1, kind: 'llm', text: 'key [REDACTED:aws_access_key_id]' }],
    });
  });
});
