import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { cleanDb, loginAs, makeApp, seedSchema, type TestEnv } from './helpers';
import type { Env } from '../src/env';
import { createRepo, getRef, getRepo, setRef } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import { q, q1, run } from '../src/db/client';
import { createApiToken } from '../src/auth/tokens';
import { evaluate, rulesetInputSchema, type Ruleset } from '../src/policy/rulesets';
import type { Pull } from '../shared/collaboration';
import {
  formatPredicate,
  provenanceKeysSchema,
  provenanceRecordSchema,
  verifyProvenance,
  type ProvenanceKeys,
  type ProvenanceRecord,
} from '../../cli/src/provenance';

/**
 * Signed provenance (issue #58): one forge-signed in-toto record per
 * protected ref move, verified offline by the CLI's own verifier; tampering
 * fails; `required_provenance` refuses direct moves (a bypass is on the
 * record); agent sessions link changesets to redacted transcripts that only
 * writers read; commit signing keys belong to signed-in people.
 */

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const app = makeApp(testEnv);
const author = { name: 'Ada', email: 'ada@example.com' };

type User = Awaited<ReturnType<typeof loginAs>>;
type Actor = { headers: Record<string, string> };
let owner: User;
let reviewer: User;
let reader: User;
let repoId = '';
let base = '';
let head = '';

async function cs(parent: string | null, name: string): Promise<string> {
  return (
    await commitChanges(dbEnv, repoId, {
      first_parent: parent,
      message: `add ${name}\n`,
      author,
      changes: [{ path: name, op: 'add', content_b64: btoa(name) }],
    })
  ).changeset.id;
}

async function call(
  who: Actor,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return app(
    new Request(`https://forge.test${path}`, {
      method,
      headers: { ...who.headers, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

const repoPath = (tail: string): string => `/api/v1/repos/acme/app${tail}`;

async function json<T>(res: Response, status = 200): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return JSON.parse(text) as T;
}

async function keys(): Promise<ProvenanceKeys> {
  // public: no session needed to fetch the keys records verify against
  const res = await app(
    new Request('https://forge.test/.well-known/yag-provenance-keys'),
  );
  return provenanceKeysSchema.parse(await json(res));
}

interface ApiRecord extends ProvenanceRecord {
  via: string;
  bypass: boolean;
  verified: boolean;
  reason: string | null;
  statement: { predicate: Record<string, unknown> };
}

async function records(
  changeset: string,
  who: Actor = owner,
): Promise<{
  records: ApiRecord[];
  sessions: { id: string; transcript_available: boolean }[];
  signature: unknown;
}> {
  return json(await call(who, 'GET', repoPath(`/provenance?cs=${changeset}`)));
}

async function landPull(): Promise<string> {
  const { pull } = await json<{ pull: Pull }>(
    await call(owner, 'POST', repoPath('/pulls'), {
      title: 'Add feature',
      head_cs: head,
    }),
    201,
  );
  await json(
    await call(reviewer, 'POST', repoPath(`/pulls/${pull.id}/review`), {
      head_cs: head,
      revision: pull.revision,
      decision: 'approve',
      body: '',
    }),
  );
  const merged = await json<{ pull: Pull }>(
    await call(owner, 'POST', repoPath(`/pulls/${pull.id}/merge`), {
      head_cs: head,
      revision: pull.revision,
      method: 'merge',
    }),
  );
  return merged.pull.merged_cs as string;
}

async function addRuleset(body: unknown): Promise<Ruleset> {
  return (
    await json<{ ruleset: Ruleset }>(
      await call(owner, 'POST', repoPath('/rulesets'), body),
      201,
    )
  ).ruleset;
}

beforeEach(async () => {
  await seedSchema(testEnv);
  await cleanDb(testEnv);
  owner = await loginAs(testEnv, 5801, 'owner');
  reviewer = await loginAs(testEnv, 5802, 'reviewer');
  reader = await loginAs(testEnv, 5803, 'reader');
  await json(await call(owner, 'POST', '/api/v1/orgs', { slug: 'acme' }), 201);
  const org = await q1<{ id: string }>(dbEnv, "SELECT id FROM orgs WHERE slug = 'acme'");
  repoId = (
    await createRepo(dbEnv, {
      slug: 'acme/app',
      createdBy: owner.userId,
      ownerKind: 'org',
      ownerId: org!.id,
    })
  ).id;
  await run(
    dbEnv,
    "INSERT INTO repo_members(repo_id,user_id,role) VALUES (?,?,'write')",
    [repoId, reviewer.userId],
  );
  await run(dbEnv, "INSERT INTO repo_members(repo_id,user_id,role) VALUES (?,?,'read')", [
    repoId,
    reader.userId,
  ]);
  base = await cs(null, 'README.md');
  await setRef(dbEnv, repoId, 'main', base);
  head = await cs(base, 'feature.txt');
});

describe('issuing and verifying', () => {
  it('landing a pull request on main issues one signed record that verifies offline', async () => {
    const merged = await landPull();
    const all = await q<{ ref: string }>(
      dbEnv,
      'SELECT ref FROM provenance WHERE repo_id = ?',
      [repoId],
    );
    expect(all).toEqual([{ ref: 'main' }]);

    const { records: found } = await records(merged, reader);
    expect(found).toHaveLength(1);
    const record = found[0]!;
    expect(record).toMatchObject({
      ref: 'main',
      new_cs: merged,
      via: 'merge',
      bypass: false,
      verified: true,
    });

    // `yag provenance verify` checks the same record offline with the published keys
    const published = await keys();
    const check = await verifyProvenance(
      provenanceRecordSchema.parse(record),
      published,
      merged,
    );
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.predicate).toMatchObject({
      ref: 'refs/heads/main',
      kind: 'update',
      previous: { yagChangeset: base },
      current: { yagChangeset: merged },
      via: 'merge',
      actor: { kind: 'user', id: owner.userId, login: 'owner' },
      bypass: false,
    });
    expect(check.predicate.pull_requests[0]).toMatchObject({
      number: 1,
      reviews: [{ by: 'reviewer', decision: 'approve' }],
    });
    expect(check.predicate.changesets.map((c) => c.id).sort()).toEqual(
      [merged, head].sort(),
    );
    expect(formatPredicate(check.predicate)).toContain(
      'pull request #1, approved by reviewer',
    );
    // the pull request's own commit is covered by the same record
    expect(
      (await verifyProvenance(provenanceRecordSchema.parse(record), published, head)).ok,
    ).toBe(true);
    expect(
      (await verifyProvenance(provenanceRecordSchema.parse(record), published, base)).ok,
    ).toBe(false);
  });

  it('records agent review verdicts on the revision that landed (#60)', async () => {
    const agent = await json<{ id: string }>(
      await call(owner, 'POST', '/api/v1/agents', { name: 'reviewbot', kind: 'codex' }),
      201,
    );
    await json(await call(owner, 'PUT', repoPath(`/agent-reviewers/${agent.id}`), {}));
    const { pull } = await json<{ pull: Pull }>(
      await call(owner, 'POST', repoPath('/pulls'), {
        title: 'Add feature',
        head_cs: head,
      }),
      201,
    );
    const { recordVerdict } = await import('../src/reviews/agentLoop');
    await recordVerdict(
      dbEnv,
      (await getRepo(dbEnv, repoId))!,
      pull,
      agent.id,
      {
        head_cs: head,
        revision: pull.revision,
        verdict: 'pass',
        confidence: 0.95,
        summary: 'Looks right',
        findings: [{ severity: 'low', body: 'Consider a test' }],
      },
      { kind: 'agent', id: agent.id, onBehalfOf: owner.userId },
      null,
    );
    await json(
      await call(reviewer, 'POST', repoPath(`/pulls/${pull.id}/review`), {
        head_cs: head,
        revision: pull.revision,
        decision: 'approve',
        body: '',
      }),
    );
    const merged = (
      await json<{ pull: Pull }>(
        await call(owner, 'POST', repoPath(`/pulls/${pull.id}/merge`), {
          head_cs: head,
          revision: pull.revision,
          method: 'merge',
        }),
      )
    ).pull.merged_cs as string;
    const { records: found } = await records(merged, reader);
    const check = await verifyProvenance(
      provenanceRecordSchema.parse(found[0]),
      await keys(),
      merged,
    );
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.predicate.pull_requests[0]).toMatchObject({
      agent_reviews: [
        {
          by: `agent:${agent.id}`,
          name: 'reviewbot',
          verdict: 'pass',
          confidence: 0.95,
          round: 1,
          findings: 1,
        },
      ],
    });
    expect(formatPredicate(check.predicate)).toContain(
      '  agent review by reviewbot: pass (confidence 0.95)',
    );
  });

  it('fails verification when any field is tampered with', async () => {
    const merged = await landPull();
    const record = provenanceRecordSchema.parse((await records(merged)).records[0]);
    const published = await keys();
    const statement = JSON.parse(atob(record.envelope.payload)) as {
      subject: { digest: Record<string, string> }[];
      predicate: Record<string, unknown>;
    };
    const edits: ((s: typeof statement) => void)[] = [
      (s) => (s.predicate.via = 'api'),
      (s) => (s.predicate.bypass = true),
      (s) => (s.predicate.actor = { kind: 'user', id: reviewer.userId }),
      (s) => (s.predicate.pull_requests = []),
      (s) => (s.predicate.changesets = []),
      (s) => (s.predicate.timestamp = new Date(0).toISOString()),
      (s) => (s.subject[0]!.digest.yagChangeset = base),
    ];
    for (const edit of edits) {
      const copy = structuredClone(statement);
      edit(copy);
      const tampered = {
        ...record,
        envelope: { ...record.envelope, payload: btoa(JSON.stringify(copy)) },
      };
      expect((await verifyProvenance(tampered, published, merged)).ok).toBe(false);
    }
    // a flipped signature byte, and a key the forge never published
    const sig = atob(record.envelope.signatures[0]!.sig);
    const flipped = btoa(String.fromCharCode(sig.charCodeAt(0) ^ 1) + sig.slice(1));
    const badSig = {
      ...record,
      envelope: {
        ...record.envelope,
        signatures: [{ ...record.envelope.signatures[0]!, sig: flipped }],
      },
    };
    expect((await verifyProvenance(badSig, published, merged)).ok).toBe(false);
    expect((await verifyProvenance(record, { keys: [] }, merged)).ok).toBe(false);

    // the server check notices a stored statement edited in place
    await run(dbEnv, 'UPDATE provenance SET statement = replace(statement, ?, ?)', [
      '"via":"merge"',
      '"via":"api"',
    ]);
    const [stored] = (await records(merged)).records;
    expect(stored).toMatchObject({
      verified: false,
      reason: 'the signed statement differs from the record',
    });
  });

  it('records no provenance for unprotected branches', async () => {
    const res = await call(owner, 'PUT', repoPath('/refs/topic'), {
      from: null,
      to: head,
    });
    expect(res.status).toBe(200);
    expect(await q(dbEnv, 'SELECT id FROM provenance')).toEqual([]);
  });
});

describe('required_provenance', () => {
  it('blocks a direct move that skips a pull request; a bypass is on the record', async () => {
    const ruleset = await addRuleset({
      name: 'Provenance',
      target: 'branch',
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'] } },
      rules: [{ type: 'required_provenance' }],
    });
    const direct = await call(reviewer, 'PUT', repoPath('/refs/main'), {
      from: base,
      to: head,
    });
    const refused = await json<{ error: { code: string; rule: string } }>(direct, 403);
    expect(refused.error).toMatchObject({
      code: 'ruleset_violation',
      rule: 'required_provenance',
    });
    expect((await getRef(dbEnv, repoId, 'main'))?.head).toBe(base);
    expect(await q(dbEnv, 'SELECT id FROM provenance')).toEqual([]);

    // a bypass actor may move it, and the signed record says so
    await json(
      await call(owner, 'PUT', repoPath(`/rulesets/${ruleset.id}`), {
        name: 'Provenance',
        target: 'branch',
        conditions: { ref_name: { include: ['~DEFAULT_BRANCH'] } },
        rules: [{ type: 'required_provenance' }],
        bypass: [`user:${owner.userId}`],
      }),
    );
    await json(
      await call(owner, 'PUT', repoPath('/refs/main'), { from: base, to: head }),
    );
    const [record] = (await records(head)).records;
    expect(record).toMatchObject({ via: 'api', bypass: true, verified: true });
    const check = await verifyProvenance(
      provenanceRecordSchema.parse(record),
      await keys(),
      head,
    );
    expect(check.ok && check.predicate.bypass).toBe(true);
    expect(record!.statement.predicate.rulesets).toMatchObject({
      bypassed: [{ ruleset: 'Provenance', rule: 'required_provenance' }],
    });
  });

  it('lets a reviewed pull request land', async () => {
    await addRuleset({
      name: 'Provenance',
      target: 'branch',
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'] } },
      rules: [{ type: 'required_provenance' }],
    });
    const merged = await landPull();
    expect((await records(merged)).records).toHaveLength(1);
  });

  it('refuses every update when the forge cannot sign', () => {
    const rules = [
      rulesetInputSchema.parse({
        name: 'Provenance',
        target: 'branch',
        conditions: { ref_name: { include: ['main'] } },
        rules: [{ type: 'required_provenance' }, { type: 'required_signatures' }],
      }),
    ].map((r, i) => ({
      ...r,
      id: `r${i}`,
      scope: 'repo' as const,
      owner_id: 'repo',
      created_by: 'u',
      created_at: 0,
      updated_at: 0,
    })) as Ruleset[];
    const input = (over: Record<string, unknown>) => ({
      repo: { slug: 'acme/app', default_branch: 'main' },
      actor: { principal: null, role: 'admin' as const, teams: [] },
      ref: { name: 'main', kind: 'update' as const, fastForward: true, ...over },
    });
    const merge = {
      merge: {
        approvals: 1,
        checksPassed: true,
        method: 'merge' as const,
        unresolvedThreads: 0,
      },
    };
    expect(evaluate(rules, input(merge)).allowed).toBe(true);
    expect(
      evaluate(rules, input({ ...merge, cannotSign: true })).blocking.map(
        (v) => v.message,
      ),
    ).toEqual(['main requires signed provenance, and this forge has no signing key.']);
    expect(
      evaluate(
        rules,
        input({
          ...merge,
          signatures: { unverified: ['a'.repeat(64)], truncated: false },
        }),
      ).blocking.map((v) => v.rule),
    ).toEqual(['required_signatures']);
  });
});

describe('agent sessions', () => {
  const token = `ghp_${'a1B2'.repeat(9)}`;
  const transcript = [
    JSON.stringify({ kind: 'llm', text: 'reading the feature' }),
    JSON.stringify({ kind: 'tool_call', name: 'commit', input: { token } }),
  ].join('\n');

  async function newSession(who: Actor = owner) {
    return json<{
      session: { id: string; transcript: { sha256: string; redactions: number } };
    }>(
      await call(who, 'POST', repoPath('/sessions'), {
        model: 'claude-opus-5-5',
        harness: 'claude-code 2.1',
        tools: ['read_file', 'commit'],
        started_at: Date.now() - 60_000,
        ended_at: Date.now(),
        transcript,
        changesets: [head],
      }),
      201,
    );
  }

  it('links a changeset to its redacted transcript for writers only', async () => {
    const { session } = await newSession();
    expect(session.transcript.redactions).toBe(1);

    const asOwner = await records(head);
    expect(asOwner.sessions).toEqual([
      expect.objectContaining({ id: session.id, transcript_available: true }),
    ]);
    expect((await records(head, reader)).sessions).toEqual([
      expect.objectContaining({ id: session.id, transcript_available: false }),
    ]);

    const res = await call(owner, 'GET', repoPath(`/sessions/${session.id}/transcript`));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-yag-sha256')).toBe(session.transcript.sha256);
    const text = await res.text();
    expect(text).not.toContain(token);
    expect(text).toContain('[REDACTED:');
    expect(
      (await call(reader, 'GET', repoPath(`/sessions/${session.id}/transcript`))).status,
    ).toBe(403);
    // metadata is for readers
    const meta = await json<{ changesets: string[] }>(
      await call(reader, 'GET', repoPath(`/sessions/${session.id}`)),
    );
    expect(meta.changesets).toEqual([head]);

    // the landing record carries the session and its transcript hash
    const merged = await landPull();
    const [record] = (await records(merged)).records;
    const entry = (
      record!.statement.predicate.changesets as {
        id: string;
        sessions: { id: string; model: string; transcript_sha256: string }[];
      }[]
    ).find((c) => c.id === head);
    expect(entry?.sessions).toEqual([
      expect.objectContaining({
        id: session.id,
        model: 'claude-opus-5-5',
        transcript_sha256: session.transcript.sha256,
      }),
    ]);
    const audit = await q1<{ target: string }>(
      dbEnv,
      "SELECT target FROM audit_events WHERE action = 'session.create'",
    );
    expect(JSON.parse(audit!.target)).toMatchObject({
      session_id: session.id,
      redactions: 1,
    });
  });

  it('lets only the recording credential link more changesets', async () => {
    const { session } = await newSession();
    const link = (who: Actor) =>
      call(who, 'POST', repoPath(`/sessions/${session.id}/link`), {
        changesets: [base],
      });
    expect(
      (await json<{ error: { code: string } }>(await link(reviewer), 403)).error.code,
    ).toBe('not_session_owner');
    await json(await link(owner));
    expect((await records(base)).sessions.map((s) => s.id)).toEqual([session.id]);
    const unknown = await call(owner, 'POST', repoPath(`/sessions/${session.id}/link`), {
      changesets: ['f'.repeat(64)],
    });
    expect((await json<{ error: { code: string } }>(unknown, 404)).error.code).toBe(
      'changeset_not_found',
    );
  });

  it('takes the agent identity from an agent token, never from the body', async () => {
    const delegate = (
      await createApiToken(dbEnv, owner.userId, {
        label: 'delegate',
        scopes: ['repo:read', 'repo:write', 'agent:run'],
      })
    ).raw;
    const { id } = await json<{ id: string }>(
      await call(owner, 'POST', '/api/v1/agents', {
        name: 'Builder',
        kind: 'claude_code',
        max_risk: 'high',
        max_scopes: ['contents:read', 'contents:write'],
      }),
      201,
    );
    const exchange = async (scope: string): Promise<Actor> => {
      const res = await app(
        new Request('https://forge.test/oauth/token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
            subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
            subject_token: delegate,
            agent_id: id,
            resource: 'acme/app',
            scope,
          }),
        }),
      );
      const { access_token } = await json<{ access_token: string }>(res);
      return { headers: { authorization: `Bearer ${access_token}` } };
    };
    const readOnly = await exchange('contents:read');
    expect(
      (await call(readOnly, 'POST', repoPath('/sessions'), { started_at: Date.now() }))
        .status,
    ).toBe(403);
    const agent = await exchange('contents:read contents:write');
    const { session } = await json<{
      session: { agent_id: string; on_behalf_of: string };
    }>(
      await call(agent, 'POST', repoPath('/sessions'), {
        agent_id: 'agt_forged',
        started_at: Date.now(),
        changesets: [head],
      }),
      201,
    );
    expect(session).toMatchObject({ agent_id: id, on_behalf_of: owner.userId });
  });
});

describe('signing keys', () => {
  async function sshKey(): Promise<string> {
    const pair = (await crypto.subtle.generateKey('Ed25519', true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const raw = new Uint8Array(
      (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer,
    );
    const str = (b: Uint8Array) => {
      const out = new Uint8Array(4 + b.length);
      new DataView(out.buffer).setUint32(0, b.length);
      out.set(b, 4);
      return out;
    };
    const type = new TextEncoder().encode('ssh-ed25519');
    const blob = new Uint8Array([...str(type), ...str(raw)]);
    return `ssh-ed25519 ${btoa(String.fromCharCode(...blob))} ada@laptop`;
  }

  it('adds, lists and removes keys from a signed-in session only', async () => {
    const publicKey = await sshKey();
    const added = await json<{ key: { id: string; fingerprint: string } }>(
      await call(owner, 'POST', '/api/v1/me/signing-keys', {
        kind: 'ssh',
        title: 'Laptop',
        public_key: publicKey,
      }),
      201,
    );
    expect(added.key.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    const dup = await call(reviewer, 'POST', '/api/v1/me/signing-keys', {
      kind: 'ssh',
      title: 'Mine now',
      public_key: publicKey,
    });
    expect((await json<{ error: { code: string } }>(dup, 409)).error.code).toBe(
      'signing_key_exists',
    );
    const bad = await call(owner, 'POST', '/api/v1/me/signing-keys', {
      kind: 'gpg',
      title: 'Nope',
      public_key: 'not a key',
    });
    expect((await json<{ error: { code: string } }>(bad, 400)).error.code).toBe(
      'invalid_signing_key',
    );
    const api = (
      await createApiToken(dbEnv, owner.userId, { label: 't', scopes: ['repo:write'] })
    ).raw;
    const viaToken = await call(
      { headers: { authorization: `Bearer ${api}` } },
      'GET',
      '/api/v1/me/signing-keys',
    );
    expect((await json<{ error: { code: string } }>(viaToken, 403)).error.code).toBe(
      'session_required',
    );
    const listed = await json<{ keys: { id: string }[] }>(
      await call(owner, 'GET', '/api/v1/me/signing-keys'),
    );
    expect(listed.keys.map((k) => k.id)).toEqual([added.key.id]);
    expect(
      (await call(reviewer, 'DELETE', `/api/v1/me/signing-keys/${added.key.id}`)).status,
    ).toBe(404);
    expect(
      (await call(owner, 'DELETE', `/api/v1/me/signing-keys/${added.key.id}`)).status,
    ).toBe(204);
    const actions = await q<{ action: string }>(
      dbEnv,
      "SELECT action FROM audit_events WHERE action LIKE 'signing_key.%' ORDER BY id",
    );
    expect(actions.map((a) => a.action)).toEqual([
      'signing_key.add',
      'signing_key.remove',
    ]);
  });
});
