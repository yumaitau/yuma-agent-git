import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { RequestBody } from '@yuma/agent-git-sdk';

/**
 * `yag policy test` (issue #62): run an agent policy file against fixture
 * cases on the server's own engine (`POST /api/v1/policy/test`), so the CLI
 * never carries a second copy of the rules. Fixtures are JSON arrays of
 * `{name, input, expect}`; a directory runs every `.json` file in it.
 */

type TestBody = RequestBody<'testPolicy'>;
type Case = TestBody['cases'][number];

const resultSchema = z.object({
  passed: z.number(),
  failed: z.number(),
  results: z.array(
    z.object({
      name: z.string(),
      expect: z.string(),
      outcome: z.string(),
      pass: z.boolean(),
      matches: z.array(z.object({ rule: z.string(), message: z.string() })),
    }),
  ),
});
export type PolicyTestResult = z.infer<typeof resultSchema>;

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (err) {
    throw new Error(`${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Fixture cases from a file, or from every `.json` file in a directory. */
export async function loadCases(path: string): Promise<Case[]> {
  const files = (await stat(path)).isDirectory()
    ? (await readdir(path))
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => join(path, f))
    : [path];
  const cases: Case[] = [];
  for (const file of files) {
    const data = await readJson(file);
    if (!Array.isArray(data)) throw new Error(`${file}: expected an array of cases`);
    cases.push(...(data as Case[]));
  }
  if (cases.length === 0) throw new Error(`${path}: no test cases`);
  return cases;
}

export async function testPolicy(opts: {
  api: string;
  token?: string;
  /** Policy file; omitted tests the server's default pack. */
  policy?: string;
  fixtures: string;
  fetch?: typeof fetch;
}): Promise<PolicyTestResult> {
  const body: TestBody = { cases: await loadCases(opts.fixtures) };
  if (opts.policy) body.policy = await readJson(opts.policy);
  const res = await (opts.fetch ?? fetch)(
    `${opts.api.replace(/\/$/, '')}/api/v1/policy/test`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      body: JSON.stringify(body),
    },
  );
  const payload = (await res.json().catch(() => null)) as {
    error?: { code: string; message: string };
  } | null;
  if (!res.ok) {
    const error = payload?.error;
    throw new Error(
      error
        ? `${error.code}: ${error.message}`
        : `policy test failed: HTTP ${res.status}`,
    );
  }
  return resultSchema.parse(payload);
}

/** One line per case, failures with what matched. */
export function formatResults(result: PolicyTestResult): string[] {
  const lines = result.results.map((r) =>
    r.pass
      ? `ok   ${r.name}`
      : `FAIL ${r.name}: expected ${r.expect}, got ${r.outcome}${
          r.matches.length ? ` (${r.matches.map((m) => m.message).join('; ')})` : ''
        }`,
  );
  lines.push(`${result.passed} passed, ${result.failed} failed`);
  return lines;
}
