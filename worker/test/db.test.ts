import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { seedSchema, cleanDb } from './helpers';
import type { TestEnv } from './helpers';
import { C, INITIAL_SCHEMA_SQL, T } from '../src/db/schema';
import {
  parseChangesetRow,
  parsePathRuleRow,
  parseRepoRow,
  q,
  q1,
  run,
  tx,
} from '../src/db/client';
import { createRepo, getRef, getRepoBySlug, setRef } from '../src/db/repos';

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;

describe('db schema + helpers', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
  });

  it('creates and reads repos by slug and id (round-trip)', async () => {
    const repo = await createRepo(dbEnv, {
      slug: 'acme/widgets',
      visibility: 'public',
    });
    expect(repo.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(repo.visibility).toBe('public');
    expect(repo.default_branch).toBe('main');

    const bySlug = await getRepoBySlug(dbEnv, 'acme/widgets');
    expect(bySlug).toEqual(repo);

    const byId = await q1(dbEnv, `SELECT * FROM ${T.repos} WHERE id = ?`, [repo.id]);
    expect(parseRepoRow(byId)).toEqual(repo);
  });

  it('rejects duplicate slugs (UNIQUE)', async () => {
    await createRepo(dbEnv, { slug: 'acme/widgets' });
    await expect(createRepo(dbEnv, { slug: 'acme/widgets' })).rejects.toThrow();
  });

  it('round-trips a changeset row through the zod parser', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/widgets' });
    const row = {
      id: 'a'.repeat(64),
      repo_id: repo.id,
      first_parent: null,
      parents: JSON.stringify([]),
      author: JSON.stringify({ name: 'Ada', email: 'ada@example.com' }),
      message: 'root',
      created_at: 1_700_000_000_000,
      changed_files: JSON.stringify([
        { path: 'src/app.ts', op: 'add', hash: 'b'.repeat(64), size: 12 },
      ]),
    };
    await tx(dbEnv, (t) => {
      t.q(
        `INSERT INTO ${T.changesets}
           (${C.changesets.id}, ${C.changesets.repoId}, ${C.changesets.firstParent},
            ${C.changesets.parents}, ${C.changesets.author}, ${C.changesets.message},
            ${C.changesets.createdAt}, ${C.changesets.changedFiles})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.repo_id,
          row.first_parent,
          row.parents,
          row.author,
          row.message,
          row.created_at,
          row.changed_files,
        ],
      );
    });

    const rows = await q(dbEnv, `SELECT * FROM ${T.changesets}`);
    expect(rows).toHaveLength(1);
    expect(parseChangesetRow(rows[0])).toEqual({
      id: row.id,
      repo_id: repo.id,
      first_parent: null,
      parents: [],
      author: { name: 'Ada', email: 'ada@example.com' },
      message: 'root',
      created_at: row.created_at,
      changed_files: [{ path: 'src/app.ts', op: 'add', hash: 'b'.repeat(64), size: 12 }],
      root_tree: null,
    });
  });

  it('writes and reads refs (raw helpers)', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/widgets' });
    await setRef(dbEnv, repo.id, 'main', 'a'.repeat(64), 1);
    expect(await getRef(dbEnv, repo.id, 'main')).toEqual({
      repo_id: repo.id,
      name: 'main',
      head: 'a'.repeat(64),
      updated_at: 1,
    });

    await setRef(dbEnv, repo.id, 'main', 'b'.repeat(64), 2);
    expect((await getRef(dbEnv, repo.id, 'main'))?.head).toBe('b'.repeat(64));
    expect(await getRef(dbEnv, repo.id, 'release/1.0')).toBeNull();
  });

  it('CHECK constraints reject bad roles and statuses', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/widgets' });

    await expect(
      run(
        dbEnv,
        `INSERT INTO ${T.repoMembers} (${C.repoMembers.repoId}, ${C.repoMembers.userId}, ${C.repoMembers.role}) VALUES (?, ?, ?)`,
        [repo.id, 'user-1', 'superuser'],
      ),
    ).rejects.toThrow();

    await expect(
      run(
        dbEnv,
        `INSERT INTO ${T.agentTasks} (${C.agentTasks.id}, ${C.agentTasks.repoId}, ${C.agentTasks.kind}, ${C.agentTasks.prompt}, ${C.agentTasks.status}, ${C.agentTasks.createdBy}, ${C.agentTasks.createdAt}, ${C.agentTasks.updatedAt}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ['t1', repo.id, 'freeform', 'hi', 'exploded', 'me', 1, 1],
      ),
    ).rejects.toThrow();

    await expect(
      run(
        dbEnv,
        `INSERT INTO ${T.importJobs} (${C.importJobs.id}, ${C.importJobs.repoId}, ${C.importJobs.source}, ${C.importJobs.mode}, ${C.importJobs.status}, ${C.importJobs.createdAt}, ${C.importJobs.updatedAt}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ['j1', repo.id, 'github:a/b', 'shallow', 'queued', 1, 1],
      ),
    ).rejects.toThrow();

    await expect(
      run(
        dbEnv,
        `INSERT INTO ${T.pathRules} (${C.pathRules.repoId}, ${C.pathRules.pathPrefix}, ${C.pathRules.effect}, ${C.pathRules.principal}, ${C.pathRules.perms}) VALUES (?, ?, ?, ?, ?)`,
        [repo.id, 'secrets/', 'maybe', '*', JSON.stringify(['read'])],
      ),
    ).rejects.toThrow();
  });

  it('path_rules perms JSON parses through the row parser', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/widgets' });
    await run(
      dbEnv,
      `INSERT INTO ${T.pathRules} (${C.pathRules.repoId}, ${C.pathRules.pathPrefix}, ${C.pathRules.effect}, ${C.pathRules.principal}, ${C.pathRules.perms}) VALUES (?, ?, ?, ?, ?)`,
      [repo.id, 'secrets/', 'deny', 'role:write', JSON.stringify(['read', 'history'])],
    );
    const row = await q1(dbEnv, `SELECT * FROM ${T.pathRules}`);
    expect(parsePathRuleRow(row)).toMatchObject({
      repo_id: repo.id,
      path_prefix: 'secrets/',
      effect: 'deny',
      principal: 'role:write',
      perms: ['read', 'history'],
    });
  });

  it('INITIAL_SCHEMA_SQL stays in sync with migrations/0001_init.sql', () => {
    const migration = testEnv.TEST_MIGRATIONS.find((m) => m.name.startsWith('0001'));
    expect(migration, '0001_init migration missing').toBeDefined();

    const normalize = (statements: string[]): string[] =>
      statements
        .map((s) =>
          s
            .split('\n')
            .map((line) => line.replace(/--.*$/, '').trim())
            .filter(Boolean)
            .join(' ')
            .replace(/\s+/g, ' ')
            .replace(/;\s*$/, '')
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean)
        .sort();

    const fromSql = normalize(INITIAL_SCHEMA_SQL.split(';'));
    const fromMigration = normalize(migration?.queries ?? []);
    expect(fromSql).toEqual(fromMigration);
  });
});
