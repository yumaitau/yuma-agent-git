import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { cleanDb, loginAs, makeApp, seedSchema, type TestEnv } from './helpers';
import type { Env } from '../src/env';
import { createRepo, getRepo, setRef } from '../src/db/repos';
import { recordUsage } from '../src/usage/record';
import { commitChanges } from '../src/core/commit';
import { q, q1, run } from '../src/db/client';
import {
  advanceBackup,
  backupTick,
  readManifest,
  restoreTick,
  startBackup,
  type BackupRow,
} from '../src/backup/backup';
import { commitShas } from '../src/git/upload-pack';
import { readPack } from '../src/git/pack-reader';
import worker from '../src/index';

const testEnv = env as unknown as TestEnv;
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 7)));
const author = { name: 'Ada', email: 'ada@example.com' };
let owner: Awaited<ReturnType<typeof loginAs>>;
let repoId = '';

function withEnv(extra: Record<string, string | undefined>): Env {
  return new Proxy(testEnv, {
    get: (t, k, r) =>
      typeof k === 'string' && k in extra ? extra[k] : Reflect.get(t, k, r),
  });
}
const backupEnv = (): Env =>
  withEnv({ BACKUP_ENCRYPTION_KEY: KEY, BACKUP_ADMIN_USER_IDS: owner.userId });

function api(path: string, init: RequestInit = {}, bindings: Env = backupEnv()) {
  return makeApp(bindings)(
    new Request(`https://x/api/v1${path}`, {
      ...init,
      headers: { ...owner.headers, 'content-type': 'application/json', ...init.headers },
    }),
  );
}

async function emptyBackups(): Promise<void> {
  const listed = await testEnv.BACKUPS!.list();
  if (listed.objects.length > 0)
    await testEnv.BACKUPS!.delete(listed.objects.map((o) => o.key));
}

/** Every row of the tables a restore must bring back, in a stable order. */
async function snapshot(): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const table of [
    'users',
    'sessions',
    'repos',
    'changesets',
    'refs',
    'git_commits',
    'issues',
    'pull_requests',
    'pull_reviews',
    'audit_events',
    // wave 4a tables (#44, #51, #61, #67) come back too; usage_daily is rebuilt
    'notifications',
    'ci_artifacts',
    'code_scanning_alerts',
    'usage_events',
    'usage_daily',
  ]) {
    out[table] = await q(testEnv, `SELECT * FROM ${table} ORDER BY 1, 2`);
  }
  return out;
}

async function runBackup(bindings: Env): Promise<BackupRow> {
  const started = await startBackup(bindings, 'manual');
  expect(started).not.toBeNull();
  let row: BackupRow | null = started;
  let ticks = 0;
  // one page per tick: the backup crosses many cron ticks
  while (row?.status === 'running' && ticks++ < 500)
    row = await advanceBackup(bindings, 1);
  expect(row?.status).toBe('done');
  return (await q1<BackupRow>(testEnv, 'SELECT * FROM backups WHERE id = ?', [
    started!.id,
  ])) as BackupRow;
}

beforeEach(async () => {
  await seedSchema(testEnv);
  await cleanDb(testEnv);
  await emptyBackups();
  owner = await loginAs(testEnv, 1001, 'owner');
  const repo = await createRepo(testEnv, { slug: 'team/app', createdBy: owner.userId });
  repoId = repo.id;
  const first = await commitChanges(testEnv, repoId, {
    first_parent: null,
    message: 'first\n',
    author,
    changes: [{ path: 'README.md', op: 'add', content_b64: btoa('hello\n') }],
  });
  const second = await commitChanges(testEnv, repoId, {
    first_parent: first.changeset.id,
    message: 'second\n',
    author,
    changes: [{ path: 'src/a.ts', op: 'add', content_b64: btoa('export {};\n') }],
  });
  await setRef(testEnv, repoId, 'main', first.changeset.id);
  await setRef(testEnv, repoId, 'feature', second.changeset.id);
  await setRef(testEnv, repoId, 'refs/tags/v1', first.changeset.id);
  await commitShas(testEnv, repoId, [first.changeset.id, second.changeset.id]);
  expect(
    (
      await api('/repos/team/app/issues', {
        method: 'POST',
        body: JSON.stringify({ title: 'Secret plans for the launch', body: 'details' }),
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await api('/repos/team/app/pulls', {
        method: 'POST',
        body: JSON.stringify({ title: 'Feature', head_cs: second.changeset.id }),
      })
    ).status,
  ).toBe(201);
});

/** Rows and an R2 object in tables later issues added, so the round trip covers them. */
async function seedWave4(): Promise<void> {
  const repo = (await getRepo(testEnv, repoId))!;
  await recordUsage(testEnv, [
    {
      repo,
      kind: 'tokens',
      source: 'reported',
      model: 'claude-subscription',
      input_tokens: 10,
      at: 1_000,
    },
    {
      repo,
      kind: 'ci_seconds',
      source: 'ci',
      model: 'standard-2',
      quantity: 60,
      at: 2_000,
    },
  ]);
  await testEnv.OBJECTS.put('ci/artifacts/run-1/dist', 'built');
  await run(
    testEnv,
    `INSERT INTO ci_artifacts (id, repo_id, run_scope, ci_run_id, name, size, object_key, created_at, expires_at)
     VALUES ('art-1', ?, 'run-1', 'job-1', 'dist', 5, 'ci/artifacts/run-1/dist', 0, 1)`,
    [repoId],
  );
  await run(
    testEnv,
    `INSERT INTO notifications (id, principal, event_id, repo_id, subject_type, subject_id, number,
       title, url, origin, reason, event, action, actor, created_at)
     VALUES ('n1', ?, 'e1', ?, 'pull', '1', 1, 'Feature', '/r/team/app/pulls/1', NULL,
       'review_requested', 'pull_request', 'review_requested', NULL, 0)`,
    [`user:${owner.userId}`, repoId],
  );
  await run(
    testEnv,
    `INSERT INTO code_scanning_alerts (repo_id, ref, tool, category, fingerprint, rule_id,
       severity, message, path, state, last_analysis_id, created_at, updated_at)
     VALUES (?, 'main', 'semgrep', 'sast', 'f1', 'sqli', 'high', 'Tainted', 'a.ts', 'open', 1, 0, 0)`,
    [repoId],
  );
}

describe('backups (#70)', () => {
  it('backs up encrypted and restores into a fresh environment', async () => {
    const bindings = backupEnv();
    await seedWave4();
    const before = await snapshot();
    const row = await runBackup(bindings);
    expect(row.row_count).toBeGreaterThan(0);
    expect(row.object_count).toBeGreaterThan(0);

    // nothing in the backup bucket is readable without the key
    const listed = await testEnv.BACKUPS!.list({ prefix: `backups/${row.id}/` });
    expect(listed.objects.length).toBeGreaterThan(2);
    for (const o of listed.objects) {
      const text = await (await testEnv.BACKUPS!.get(o.key))!.text();
      expect(text).not.toContain('Secret plans');
      expect(text).not.toContain('"slug"');
    }
    const manifest = await readManifest(bindings, row.id);
    const order = manifest!.tables.map((t) => t.name);
    // parents before children
    expect(order.indexOf('repos')).toBeLessThan(order.indexOf('refs'));
    expect(order.indexOf('users')).toBeLessThan(order.indexOf('sessions'));
    expect(order.indexOf('pull_requests')).toBeLessThan(order.indexOf('pull_reviews'));
    // the wrong key reads nothing
    await expect(
      readManifest(withEnv({ BACKUP_ENCRYPTION_KEY: btoa('x'.repeat(32)) }), row.id),
    ).rejects.toThrow();

    // a fresh environment: empty database, same migrations, same objects
    await cleanDb(testEnv);
    const restoring = withEnv({ BACKUP_ENCRYPTION_KEY: KEY, RESTORE_BACKUP_ID: row.id });
    let restored: BackupRow | null = null;
    for (let i = 0; i < 500 && restored?.status !== 'done'; i++) {
      restored = await restoreTick(restoring, 2);
      expect(restored?.status).not.toBe('failed');
    }
    expect(restored).toMatchObject({ status: 'done', kind: 'restore', error: null });
    expect(restored!.row_count).toBe(row.row_count);
    expect(restored!.object_count).toBe(row.object_count);
    // timings are recorded on the restore row
    expect(restored!.finished_at).toBeGreaterThanOrEqual(restored!.started_at);
    expect(await snapshot()).toEqual(before);

    // the restored forge serves the same repository to the same session
    const file = await api('/repos/team/app/file?cs=main&path=README.md', {}, testEnv);
    expect(file.status).toBe(200);
    // a finished restore never runs again
    expect((await restoreTick(restoring))?.status).toBe('done');
  });

  it('refuses to restore over existing data and reports missing objects', async () => {
    const row = await runBackup(backupEnv());
    const restoring = withEnv({ BACKUP_ENCRYPTION_KEY: KEY, RESTORE_BACKUP_ID: row.id });
    expect(await restoreTick(restoring)).toBeNull();
    expect(await q1(testEnv, "SELECT 1 FROM backups WHERE kind = 'restore'")).toBeNull();

    // objects the manifest lists but the new bucket lacks are reported
    await cleanDb(testEnv);
    const listed = await testEnv.OBJECTS.list({ limit: 1 });
    const gone = listed.objects[0]!.key;
    const bytes = await (await testEnv.OBJECTS.get(gone))!.arrayBuffer();
    await testEnv.OBJECTS.delete(gone);
    let restored: BackupRow | null = null;
    for (let i = 0; i < 500 && restored?.status !== 'done'; i++)
      restored = await restoreTick(restoring);
    await testEnv.OBJECTS.put(gone, bytes);
    expect(restored?.error).toMatch(/1 objects missing/);
  });

  it('schedules backups on the interval and expires old ones', async () => {
    // without a key nothing is written
    await backupTick(withEnv({ BACKUP_ENCRYPTION_KEY: undefined }));
    expect(await q1(testEnv, 'SELECT 1 FROM backups')).toBeNull();

    const bindings = backupEnv();
    const t0 = Date.now();
    for (let i = 0; i < 50; i++) await backupTick(bindings, t0);
    const first = await q<BackupRow>(testEnv, 'SELECT * FROM backups');
    expect(first).toHaveLength(1);
    expect(first[0]?.status).toBe('done');
    // not due again for 15 minutes
    await backupTick(bindings, t0 + 14 * 60_000);
    expect(await q(testEnv, 'SELECT 1 FROM backups')).toHaveLength(1);
    await backupTick(bindings, t0 + 15 * 60_000);
    expect(await q(testEnv, 'SELECT 1 FROM backups')).toHaveLength(2);
    for (let i = 0; i < 50; i++) await backupTick(bindings, t0 + 15 * 60_000);

    // past retention the older one goes; the newest always stays
    await run(testEnv, 'UPDATE backups SET started_at = started_at - ?', [
      31 * 86_400_000,
    ]);
    await backupTick(
      withEnv({ BACKUP_ENCRYPTION_KEY: KEY, BACKUP_INTERVAL_MINUTES: '100000' }),
    );
    const after = await q<BackupRow>(testEnv, 'SELECT * FROM backups ORDER BY id');
    expect(after.map((b) => b.status)).toEqual(['expired', 'done']);
    expect(
      (await testEnv.BACKUPS!.list({ prefix: `backups/${after[0]!.id}/` })).objects,
    ).toEqual([]);
  });

  it('runs only the restore while RESTORE_BACKUP_ID is set', async () => {
    const now = Date.now();
    await run(
      testEnv,
      `INSERT INTO mirrors (id, repo_id, direction, remote_url, auth, interval_s, force,
         origin, created_by, created_at, updated_at)
       VALUES ('m1', ?, 'push', 'https://github.com/acme/app.git', 'github_app', 60, 1,
         'https://x', ?, ?, ?)`,
      [repoId, owner.userId, now, now],
    );
    const sent: unknown[] = [];
    const restoring = new Proxy(withEnv({ RESTORE_BACKUP_ID: 'missing' }), {
      get: (t, k, r) =>
        k === 'MIRROR_QUEUE'
          ? { sendBatch: async (messages: unknown[]) => void sent.push(...messages) }
          : Reflect.get(t, k, r),
    });
    await worker.scheduled({} as ScheduledController, restoring);
    expect(sent).toEqual([]);
    const batch = {
      queue: 'mirror-sync',
      messages: [],
      retried: false,
      retryAll() {
        this.retried = true;
      },
      ackAll() {
        throw new Error('acked during a restore');
      },
    };
    await worker.queue(batch as unknown as MessageBatch, restoring);
    expect(batch.retried).toBe(true);
  });

  it('lets only backup admins list and start backups', async () => {
    const anon = await makeApp(backupEnv())(
      new Request('https://x/api/v1/admin/backups'),
    );
    expect(anon.status).toBe(401);
    const other = await loginAs(testEnv, 1002, 'other');
    const denied = await api('/admin/backups', { headers: other.headers });
    expect(denied.status).toBe(403);
    const started = await api('/admin/backups', { method: 'POST' });
    expect(started.status).toBe(202);
    expect((await api('/admin/backups', { method: 'POST' })).status).toBe(409);
    const list = (await (await api('/admin/backups')).json()) as {
      backups: { status: string; cursor?: unknown }[];
    };
    expect(list.backups).toHaveLength(1);
    expect(list.backups[0]).not.toHaveProperty('cursor');
    expect(
      await q1(testEnv, "SELECT 1 FROM audit_events WHERE action = 'backup.create'"),
    ).not.toBeNull();
    const unset = await api(
      '/admin/backups',
      { method: 'POST' },
      withEnv({ BACKUP_ADMIN_USER_IDS: owner.userId, BACKUP_ENCRYPTION_KEY: undefined }),
    );
    expect(unset.status).toBe(503);
  });
});

describe('repository export (#70)', () => {
  it('exports a Git bundle with the same commit SHAs', async () => {
    const res = await api('/repos/team/app/export/bundle');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-git-bundle');
    const bytes = new Uint8Array(await res.arrayBuffer());
    const split = bytes.findIndex((b, i) => b === 10 && bytes[i + 1] === 10);
    const header = new TextDecoder().decode(bytes.subarray(0, split)).split('\n');
    expect(header[0]).toBe('# v2 git bundle');
    const refs = new Map(header.slice(1).map((l) => [l.split(' ')[1], l.split(' ')[0]]));
    const rows = await q<{ name: string; head: string }>(
      testEnv,
      'SELECT name, head FROM refs WHERE repo_id = ?',
      [repoId],
    );
    const shas = await commitShas(
      testEnv,
      repoId,
      rows.map((r) => r.head),
    );
    for (const r of rows) {
      const name = r.name.startsWith('refs/') ? r.name : `refs/heads/${r.name}`;
      expect(refs.get(name)).toBe(shas.get(r.head));
    }
    expect(refs.get('HEAD')).toBe(refs.get('refs/heads/main'));
    const objects = await readPack(
      bytes.subarray(split + 2),
      { maxObjects: 1000, maxObjectBytes: 1 << 20, maxTotalBytes: 1 << 24 },
      async () => null,
    );
    for (const sha of shas.values()) expect(objects.get(sha)?.type).toBe('commit');
  });

  it('exports issues, pull requests and reviews as JSON', async () => {
    const res = await api('/repos/team/app/export/metadata');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      format: string;
      refs: { name: string; sha1: string }[];
      users: Record<string, string>;
      tables: Record<string, Record<string, unknown>[]>;
    };
    expect(body.format).toBe('yag-repo-export/1');
    expect(body.tables.issues?.[0]).toMatchObject({
      title: 'Secret plans for the launch',
    });
    expect(body.tables.pull_requests).toHaveLength(1);
    expect(body.tables).toHaveProperty('pull_reviews');
    expect(body.users[owner.userId]).toBe('owner');
    expect(body.refs.find((r) => r.name === 'refs/heads/main')?.sha1).toMatch(
      /^[0-9a-f]{40}$/,
    );
  });

  it('needs whole-repository read', async () => {
    const stranger = await loginAs(testEnv, 1003, 'stranger');
    for (const path of ['bundle', 'metadata']) {
      const res = await api(`/repos/team/app/export/${path}`, {
        headers: stranger.headers,
      });
      expect(res.status).toBe(404);
    }
  });
});
