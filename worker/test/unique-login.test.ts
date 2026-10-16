import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { seedSchema, type TestEnv } from './helpers';

const testEnv = env as unknown as TestEnv;

describe('migration 0015 on a database with duplicate logins', () => {
  it('keeps the name for the GitHub-less holder, then the oldest, and suffixes the rest', async () => {
    await applyD1Migrations(
      testEnv.DB,
      testEnv.TEST_MIGRATIONS.filter((m) => m.name < '0015'),
    );
    for (const [id, gh, login, at] of [
      ['gh-early', 1, 'ceo', 1],
      ['scim-ceo', null, 'ceo', 5],
      ['gh-a', 2, 'Ann', 2],
      ['gh-b', 3, 'ann', 3],
      ['solo', 4, 'solo', 1],
    ] as const) {
      await testEnv.DB.prepare(
        'INSERT INTO users (id, github_id, login, created_at) VALUES (?, ?, ?, ?)',
      )
        .bind(id, gh, login, at)
        .run();
    }
    await seedSchema(testEnv); // applies 0015 on top
    const rows = await testEnv.DB.prepare('SELECT id, login FROM users ORDER BY id').all<{
      id: string;
      login: string;
    }>();
    const login = Object.fromEntries(rows.results.map((r) => [r.id, r.login]));
    expect(login).toMatchObject({ 'scim-ceo': 'ceo', 'gh-a': 'Ann', solo: 'solo' });
    expect(login['gh-early']).toMatch(/^ceo-[0-9a-f]{6}$/);
    expect(login['gh-b']).toMatch(/^ann-[0-9a-f]{6}$/);
  });
});
