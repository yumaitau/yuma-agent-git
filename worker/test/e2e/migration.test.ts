import { describe, expect, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import type { Env } from '../../src/env';
import type { TestEnv } from '../helpers';
import { getRepoBySlug, createRepo, listRefs } from '../../src/db/repos';
import { nextNumber } from '../../src/collab/issues';

/**
 * Migration convergence (issue #22): `worker/migrations` applied in one go to
 * an empty D1 must end at the same effective schema as a D1 that ran the
 * early migrations, accumulated early-era rows, and then caught up. Those
 * rows must survive the upgrade and stay readable by today's code.
 *
 * Storage is isolated per test file, so dropping every table here cannot
 * disturb other suites; each scenario starts from a wiped database.
 */

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
/** Migrations applied before the early-era rows are written (0001–0003). */
const EARLY = 3;

const userTables = async (): Promise<string[]> =>
  (
    await testEnv.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'
         AND substr(name, 1, 7) != 'sqlite_' AND substr(name, 1, 4) != '_cf_'
       ORDER BY name`,
    ).all<{ name: string }>()
  ).results.map((r) => r.name);

/** Drop every table (children first — retry until FK order settles). */
async function wipe(): Promise<void> {
  for (let pass = 0; pass < 10; pass++) {
    const tables = await userTables();
    if (tables.length === 0) return;
    for (const table of tables) {
      try {
        await testEnv.DB.prepare(`DROP TABLE "${table}"`).run();
      } catch {
        // still referenced by a child row; next pass
      }
    }
  }
  expect(await userTables()).toEqual([]);
}

interface Schema {
  migrations: string[];
  tables: Record<string, { columns: unknown[]; indexes: unknown[]; fks: unknown[] }>;
}

/** Effective schema: PRAGMA table_info / index_list / foreign_key_list. */
async function snapshot(): Promise<Schema> {
  const tables: Schema['tables'] = {};
  for (const table of await userTables()) {
    if (table === 'd1_migrations') continue;
    const pragma = async (name: string): Promise<unknown[]> =>
      (await testEnv.DB.prepare(`PRAGMA ${name}("${table}")`).all()).results;
    // `seq` is creation order — not part of the effective schema
    const indexes = (await pragma('index_list')) as { name: string; seq: number }[];
    tables[table] = {
      columns: await pragma('table_info'),
      indexes: indexes
        .map(({ seq: _seq, ...rest }) => rest)
        .sort((a, b) => a.name.localeCompare(b.name)),
      fks: await pragma('foreign_key_list'),
    };
  }
  const migrations = (
    await testEnv.DB.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{
      name: string;
    }>()
  ).results.map((r) => r.name);
  return { migrations, tables };
}

/** Rows shaped like the 0001–0003 era: no created_by / root_tree / github_issue. */
async function seedEarlyRows(): Promise<void> {
  const now = 1_700_000_000_000;
  const cs = 'c'.repeat(64);
  const stmts = [
    [
      `INSERT INTO repos (id, slug, default_branch, created_at, visibility) VALUES (?, ?, 'main', ?, 'public')`,
      ['repo-early', 'acme/early', now],
    ],
    [
      `INSERT INTO changesets (id, repo_id, first_parent, parents, author, message, created_at, changed_files)
       VALUES (?, 'repo-early', NULL, '[]', ?, 'root', ?, '[]')`,
      [cs, JSON.stringify({ name: 'Ada', email: 'ada@example.com' }), now],
    ],
    [
      `INSERT INTO refs (repo_id, name, head, updated_at) VALUES ('repo-early', 'main', ?, ?)`,
      [cs, now],
    ],
    [
      `INSERT INTO users (id, github_id, login, created_at) VALUES ('user-early', 7, 'ada', ?)`,
      [now],
    ],
    [
      `INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ('h', 'user-early', ?, ?)`,
      [now, now + 1],
    ],
    [
      `INSERT INTO repo_members (repo_id, user_id, role) VALUES ('repo-early', 'user-early', 'admin')`,
      [],
    ],
    [
      `INSERT INTO path_rules (repo_id, path_prefix, effect, principal, perms) VALUES ('repo-early', 'secret/', 'deny', '*', '["read"]')`,
      [],
    ],
    [
      `INSERT INTO agent_tasks (id, repo_id, kind, prompt, created_by, created_at, updated_at)
       VALUES ('task-early', 'repo-early', 'freeform', 'p', 'user-early', ?, ?)`,
      [now, now],
    ],
    [
      `INSERT INTO import_jobs (id, repo_id, source, mode, created_at, updated_at)
       VALUES ('job-early', 'repo-early', 'github:acme/early', 'snapshot', ?, ?)`,
      [now, now],
    ],
    [
      `INSERT INTO derived_data (repo_id, kind, cs_id, payload, computed_at) VALUES ('repo-early', 'skip_list', ?, '{}', ?)`,
      [cs, now],
    ],
    [
      `INSERT INTO oauth_states (state_hash, created_at, expires_at) VALUES ('s', ?, ?)`,
      [now, now + 1],
    ],
  ] as const;
  await testEnv.DB.batch(
    stmts.map(([sql, params]) => testEnv.DB.prepare(sql).bind(...params)),
  );
}

describe('migrations converge', () => {
  it('migration files are ordered and numbered', () => {
    const names = testEnv.TEST_MIGRATIONS.map((m) => m.name);
    expect(names.length).toBeGreaterThan(EARLY);
    expect([...names].sort()).toEqual(names);
    names.forEach((name, i) =>
      expect(name).toMatch(new RegExp(`^${String(i + 1).padStart(4, '0')}_`)),
    );
  });

  it('fresh apply and upgrade-with-early-rows end at the same schema', async () => {
    // A: empty → all migrations
    await wipe();
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
    const fresh = await snapshot();

    // B: empty → early migrations → early-era rows → the rest
    await wipe();
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS.slice(0, EARLY));
    expect((await snapshot()).tables.repos?.columns).not.toEqual(
      fresh.tables.repos?.columns,
    ); // the later ALTERs really are still pending
    await seedEarlyRows();
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
    const upgraded = await snapshot();

    expect(upgraded.migrations).toEqual(testEnv.TEST_MIGRATIONS.map((m) => m.name));
    expect(Object.keys(upgraded.tables).sort()).toEqual(Object.keys(fresh.tables).sort());
    for (const table of Object.keys(fresh.tables)) {
      expect(upgraded.tables[table], `schema of ${table}`).toEqual(fresh.tables[table]);
    }
    expect(upgraded).toEqual(fresh);

    // early rows survived; columns added later read as NULL
    const repo = await getRepoBySlug(dbEnv, 'acme/early');
    expect(repo).toMatchObject({ id: 'repo-early', visibility: 'public' });
    expect(repo?.created_by ?? null).toBeNull();
    const cs = await testEnv.DB.prepare('SELECT root_tree FROM changesets').first();
    expect(cs).toEqual({ root_tree: null });
    const task = await testEnv.DB.prepare('SELECT github_issue FROM agent_tasks').first();
    expect(task).toEqual({ github_issue: null });
    const member = await testEnv.DB.prepare('SELECT role FROM repo_members').first();
    expect(member).toEqual({ role: 'admin' }); // survives the 0017 triage rebuild
    expect(await listRefs(dbEnv, 'repo-early')).toEqual([
      expect.objectContaining({ name: 'main', head: 'c'.repeat(64) }),
    ]);
    // …and today's write path works alongside them
    const fresher = await createRepo(dbEnv, {
      slug: 'acme/after',
      visibility: 'private',
      createdBy: 'user-early',
    });
    expect(fresher.created_by).toBe('user-early');

    // re-applying is a no-op
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
    expect(await snapshot()).toEqual(upgraded);
  });

  it('keeps pull request numbers and continues the shared issue sequence', async () => {
    await wipe();
    const before = testEnv.TEST_MIGRATIONS.findIndex((m) => m.name === '0017_issues.sql');
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS.slice(0, before));
    const now = Date.now();
    for (const [id, slug] of [
      ['r1', 'acme/one'],
      ['r2', 'acme/two'],
    ]) {
      await createRepo(dbEnv, { slug: slug as string, createdBy: 'u' }, now);
      await testEnv.DB.prepare('UPDATE repos SET id = ? WHERE slug = ?')
        .bind(id, slug)
        .run();
    }
    for (const repo of ['r1', 'r2', 'r1']) {
      await testEnv.DB.prepare(
        `INSERT INTO pull_requests (repo_id, title, author_id, base_ref, base_cs, head_cs,
           state, created_at, updated_at) VALUES (?, 't', 'u', 'main', 'b', 'h', 'open', ?, ?)`,
      )
        .bind(repo, now, now)
        .run();
    }
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
    const pulls = await testEnv.DB.prepare(
      'SELECT repo_id, id, number FROM pull_requests ORDER BY id',
    ).all();
    expect(pulls.results).toEqual([
      { repo_id: 'r1', id: 1, number: 1 },
      { repo_id: 'r2', id: 2, number: 2 },
      { repo_id: 'r1', id: 3, number: 3 },
    ]);
    expect(await nextNumber(dbEnv, 'r1')).toBe(4);
    expect(await nextNumber(dbEnv, 'r2')).toBe(3);
  });
});
