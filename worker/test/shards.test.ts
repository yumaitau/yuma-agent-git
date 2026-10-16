import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { cleanDb, loginAs, makeApp, seedSchema, type TestEnv } from './helpers';
import type { Env } from '../src/env';
import { createRepo } from '../src/db/repos';
import { q1, run } from '../src/db/client';
import { ApiError } from '../src/core/errors';
import { advanceShardMoves, shardForOrg, shardParts } from '../src/db/router';
import {
  budgetUsed,
  recordUsage,
  type Budget,
  type UsageEvent,
} from '../src/usage/record';

/**
 * Metadata sharding (issue #78, ADR 0006): two orgs on two D1 databases in
 * miniflare. `DB_SHARD_1` exists only in the test config (vitest.config.ts).
 */

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const app = makeApp(testEnv);
const shard = (): D1Database => dbEnv.DB_SHARD_1 as D1Database;

type Login = Awaited<ReturnType<typeof loginAs>>;
type Repo = NonNullable<UsageEvent['repo']>;

async function count(db: D1Database, org: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM usage_events WHERE org_id = ?')
    .bind(org)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

function tokens(repo: Repo, n: number, agent = 'agt_x', at = Date.now()): UsageEvent[] {
  return Array.from({ length: n }, () => ({
    repo,
    agent_id: agent,
    kind: 'tokens' as const,
    source: 'reported' as const,
    model: 'gpt-x',
    input_tokens: 10,
    output_tokens: 1,
    at,
  }));
}

const agentBudget = (agent: string): Budget => ({
  id: 'b1',
  scope: 'agent',
  scope_id: agent,
  metric: 'tokens',
  period: 'month',
  soft_limit: null,
  hard_limit: 1,
  created_by: 'u',
  created_at: 0,
  updated_at: 0,
});

describe('metadata shards (#78)', () => {
  let owner: Login;
  let acme: Repo;
  let beta: Repo;

  beforeAll(async () => {
    await applyD1Migrations(shard(), testEnv.TEST_MIGRATIONS);
  });

  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
    for (const db of [dbEnv.DB, shard()]) {
      await db.prepare('DELETE FROM usage_daily').run();
      await db.prepare('DELETE FROM usage_events').run();
    }
    await run(dbEnv, 'DELETE FROM shard_directory');
    owner = await loginAs(testEnv, 7801, 'owner');
    const now = Date.now();
    for (const [id, slug] of [
      ['o1', 'acme'],
      ['o2', 'beta'],
    ]) {
      await run(
        dbEnv,
        'INSERT OR IGNORE INTO orgs (id, slug, display_name, created_at) VALUES (?,?,?,?)',
        [id, slug, slug, now],
      );
      await run(
        dbEnv,
        "INSERT OR IGNORE INTO org_members (org_id, user_id, role) VALUES (?, ?, 'owner')",
        [id, owner.userId],
      );
    }
    const make = async (slug: string, org: string): Promise<Repo> => {
      const repo = await createRepo(dbEnv, { slug, createdBy: owner.userId });
      await run(dbEnv, "UPDATE repos SET owner_kind = 'org', owner_id = ? WHERE id = ?", [
        org,
        repo.id,
      ]);
      return { id: repo.id, owner_kind: 'org', owner_id: org };
    };
    acme = await make('acme/app', 'o1');
    beta = await make('beta/app', 'o2');
    await run(
      dbEnv,
      "INSERT INTO shard_directory (org_id, shard, updated_at) VALUES ('o2', 'DB_SHARD_1', ?)",
      [now],
    );
  });

  async function orgReport(
    slug: string,
  ): Promise<{ events: number; input_tokens: number }> {
    const res = await app(
      new Request(`https://x/api/v1/orgs/${slug}/usage`, { headers: owner.headers }),
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as { totals: { events: number; input_tokens: number } })
      .totals;
  }

  it('keeps each org on its own database and routes reads to it', async () => {
    await recordUsage(dbEnv, [...tokens(acme, 3), ...tokens(beta, 5)]);
    expect(await count(dbEnv.DB, 'o1')).toBe(3);
    expect(await count(dbEnv.DB, 'o2')).toBe(0);
    expect(await count(shard(), 'o2')).toBe(5);
    expect(await count(shard(), 'o1')).toBe(0);
    expect(await orgReport('acme')).toMatchObject({ events: 3, input_tokens: 30 });
    expect(await orgReport('beta')).toMatchObject({ events: 5, input_tokens: 50 });
    const repo = await app(
      new Request('https://x/api/v1/repos/beta/app/usage?group_by=day', {
        headers: owner.headers,
      }),
    );
    expect(((await repo.json()) as { totals: { events: number } }).totals.events).toBe(5);
  });

  it('leaves the other org untouched by a write burst', async () => {
    await recordUsage(dbEnv, tokens(acme, 2));
    const before = await dbEnv.DB.prepare(
      'SELECT COUNT(*) AS n FROM usage_daily',
    ).first();
    for (let i = 0; i < 10; i++) await recordUsage(dbEnv, tokens(beta, 50));
    expect(await count(shard(), 'o2')).toBe(500);
    expect(await count(dbEnv.DB, 'o1')).toBe(2);
    expect(
      await dbEnv.DB.prepare('SELECT COUNT(*) AS n FROM usage_daily').first(),
    ).toEqual(before);
  });

  it("adds up an agent's usage across shards", async () => {
    await recordUsage(dbEnv, [...tokens(acme, 2, 'agt_x'), ...tokens(beta, 3, 'agt_x')]);
    expect(await budgetUsed(dbEnv, agentBudget('agt_x'))).toBe(5 * 11);
    expect(await shardParts(dbEnv)).toHaveLength(2);
  });

  it('defaults to DB with no directory row and fails closed on an unbound shard', async () => {
    expect(await shardForOrg(dbEnv, 'o1')).toBe(dbEnv.DB);
    expect(await shardForOrg(dbEnv, null)).toBe(dbEnv.DB);
    await run(dbEnv, 'DELETE FROM shard_directory');
    expect(await shardParts(dbEnv)).toEqual([
      { db: dbEnv.DB, where: '1 = 1', params: [] },
    ]);
    await run(
      dbEnv,
      "INSERT INTO shard_directory (org_id, shard, updated_at) VALUES ('o1', 'DB_SHARD_9', 0)",
    );
    await expect(shardForOrg(dbEnv, 'o1')).rejects.toThrow(
      'shard DB_SHARD_9 is not bound',
    );
    await expect(recordUsage(dbEnv, tokens(acme, 1))).rejects.toThrow();
    expect(await count(dbEnv.DB, 'o1')).toBe(0);
  });

  it('moves an org online: copy, freeze, flip, then late writes', async () => {
    const at = Date.now();
    await recordUsage(dbEnv, tokens(acme, 450, 'agt_x', at));
    await run(
      dbEnv,
      "INSERT INTO shard_directory (org_id, shard, target, state, updated_at) VALUES ('o1', 'DB', 'DB_SHARD_1', 'copying', 0)",
    );
    // one page per tick: the org keeps reading and writing on DB meanwhile
    await advanceShardMoves(dbEnv, 1);
    expect(await count(shard(), 'o1')).toBe(200);
    await recordUsage(dbEnv, tokens(acme, 5, 'agt_x', at));
    expect(await orgReport('acme')).toMatchObject({ events: 455 });
    expect(await budgetUsed(dbEnv, agentBudget('agt_x'))).toBe(455 * 11);

    // a frozen org refuses writes rather than lose them
    await run(dbEnv, "UPDATE shard_directory SET state = 'frozen' WHERE org_id = 'o1'");
    const refused = await recordUsage(dbEnv, tokens(acme, 1)).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).code).toBe('shard_moving');
    expect((refused as ApiError).status).toBe(503);

    await advanceShardMoves(dbEnv);
    expect(
      await q1(
        dbEnv,
        "SELECT shard, target, state FROM shard_directory WHERE org_id = 'o1'",
      ),
    ).toEqual({ shard: 'DB_SHARD_1', target: 'DB', state: 'settling' });
    expect(await count(shard(), 'o1')).toBe(455);
    const audit = await q1<{ org_id: string; target: string }>(
      dbEnv,
      "SELECT org_id, target FROM audit_events WHERE action = 'shard.move'",
    );
    expect(audit?.org_id).toBe('acme');
    expect(JSON.parse(audit!.target)).toEqual({
      org_id: 'o1',
      from: 'DB',
      to: 'DB_SHARD_1',
    });
    // a write that resolved DB before the freeze and landed after the copy
    await dbEnv.DB.prepare(
      `INSERT INTO usage_events (id, org_id, repo_id, agent_id, kind, source, model, input_tokens, output_tokens, at, created_at)
       VALUES ('late', 'o1', ?, 'agt_x', 'tokens', 'reported', 'gpt-x', 10, 1, ?, ?)`,
    )
      .bind(acme.id, at, at)
      .run();
    await advanceShardMoves(dbEnv);
    expect(
      await q1(
        dbEnv,
        "SELECT shard, target, state FROM shard_directory WHERE org_id = 'o1'",
      ),
    ).toEqual({ shard: 'DB_SHARD_1', target: null, state: 'active' });
    expect(await count(shard(), 'o1')).toBe(456);
    // the old copy stays on DB until an operator deletes it, and is never counted
    expect(await count(dbEnv.DB, 'o1')).toBe(456);
    expect(await orgReport('acme')).toMatchObject({ events: 456, input_tokens: 4560 });
    expect(await budgetUsed(dbEnv, agentBudget('agt_x'))).toBe(456 * 11);
    await recordUsage(dbEnv, tokens(acme, 1));
    expect(await count(shard(), 'o1')).toBe(457);
    expect(await count(dbEnv.DB, 'o1')).toBe(456);
  });
});
