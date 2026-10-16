import { z } from 'zod';
import {
  envelopeSchema,
  fromBase64,
  pae,
  PAYLOAD_TYPE,
  statementSchema,
  type Envelope,
  type VerifyResult,
} from './release.js';

/**
 * `yag provenance verify <cs>` (issue #58): checks the forge's signed source
 * provenance for a changeset offline, against the keys published at
 * `/.well-known/yag-provenance-keys`. The server's own `verified` flag is
 * never trusted: the signature, the predicate type and the changeset are all
 * checked here, so a record edited anywhere on the way fails.
 */
export const SOURCE_PREDICATE = 'urn:yuma-agent-git:source-provenance:v1';

export const provenanceKeysSchema = z.object({
  keys: z.array(z.looseObject({ kid: z.string(), kty: z.literal('OKP'), x: z.string() })),
});
export type ProvenanceKeys = z.infer<typeof provenanceKeysSchema>;

/** A DSSE envelope signed with one of the forge's Ed25519 provenance keys. */
export async function verifyEd25519Envelope(
  envelope: Envelope,
  keys: ProvenanceKeys,
): Promise<VerifyResult> {
  if (envelope.payloadType !== PAYLOAD_TYPE)
    return { ok: false, reason: 'unexpected payloadType' };
  let body: Uint8Array;
  try {
    body = fromBase64(envelope.payload);
  } catch {
    return { ok: false, reason: 'payload is not base64' };
  }
  for (const signature of envelope.signatures) {
    const jwk = keys.keys.find((k) => k.kid === signature.keyid);
    if (!jwk) continue;
    let ok = false;
    try {
      const key = await crypto.subtle.importKey(
        'jwk',
        { kty: 'OKP', crv: 'Ed25519', x: jwk.x },
        { name: 'Ed25519' },
        false,
        ['verify'],
      );
      ok = await crypto.subtle.verify(
        { name: 'Ed25519' },
        key,
        fromBase64(signature.sig),
        pae(envelope.payloadType, body),
      );
    } catch {
      ok = false;
    }
    if (!ok) continue;
    try {
      const statement = statementSchema.safeParse(
        JSON.parse(new TextDecoder().decode(body)),
      );
      if (!statement.success)
        return { ok: false, reason: 'payload is not an in-toto statement' };
      return { ok: true, keyId: signature.keyid, statement: statement.data };
    } catch {
      return { ok: false, reason: 'payload is not JSON' };
    }
  }
  return { ok: false, reason: 'no signature verifies with a published key' };
}

export const provenanceRecordSchema = z.looseObject({
  id: z.string(),
  ref: z.string(),
  new_cs: z.string().nullable(),
  envelope: envelopeSchema,
});
export type ProvenanceRecord = z.infer<typeof provenanceRecordSchema>;

const revision = z.object({ yagChangeset: z.string() }).nullable();
const person = z.looseObject({ id: z.string(), login: z.string().nullable().optional() });

export const sourcePredicateSchema = z.looseObject({
  ref: z.string(),
  kind: z.enum(['create', 'update', 'delete']),
  previous: revision,
  current: revision,
  via: z.string(),
  timestamp: z.string(),
  actor: z.looseObject({ kind: z.string(), id: z.string() }),
  agent: z.looseObject({ id: z.string(), name: z.string().nullable() }).optional(),
  on_behalf_of: person.optional(),
  task_id: z.string().nullable().optional(),
  bypass: z.boolean(),
  pull_requests: z.array(
    z.looseObject({
      number: z.number(),
      reviews: z.array(z.object({ by: z.string(), decision: z.string() })),
    }),
  ),
  changesets: z.array(z.looseObject({ id: z.string() })),
});
export type SourcePredicate = z.infer<typeof sourcePredicateSchema>;

export type ProvenanceCheck =
  | { ok: true; keyId: string; predicate: SourcePredicate }
  | { ok: false; reason: string };

/** Verify one record: signature, predicate shape and that it covers `cs`. */
export async function verifyProvenance(
  record: ProvenanceRecord,
  keys: ProvenanceKeys,
  cs: string,
): Promise<ProvenanceCheck> {
  const result = await verifyEd25519Envelope(record.envelope, keys);
  if (!result.ok) return result;
  if (result.statement.predicateType !== SOURCE_PREDICATE)
    return { ok: false, reason: `unexpected predicate ${result.statement.predicateType}` };
  const predicate = sourcePredicateSchema.safeParse(result.statement['predicate']);
  if (!predicate.success) return { ok: false, reason: 'malformed source predicate' };
  const head = result.statement.subject[0]?.digest['yagChangeset'];
  if (head !== cs && !predicate.data.changesets.some((c) => c.id === cs))
    return { ok: false, reason: `the statement does not cover ${cs}` };
  return { ok: true, keyId: result.keyId, predicate: predicate.data };
}

/** Human summary of a verified predicate, one fact per line. */
export function formatPredicate(p: SourcePredicate): string[] {
  const who =
    p.agent && p.on_behalf_of
      ? `agent ${p.agent.name ?? p.agent.id} for ${p.on_behalf_of.login ?? p.on_behalf_of.id}`
      : `${p.actor.kind} ${typeof p.actor['login'] === 'string' ? p.actor['login'] : p.actor.id}`;
  const lines = [
    `${p.ref} ${p.kind} via ${p.via} at ${p.timestamp}`,
    `by ${who}${p.task_id ? ` (task ${p.task_id})` : ''}`,
  ];
  for (const pr of p.pull_requests) {
    const approvals = pr.reviews.filter((r) => r.decision === 'approve').map((r) => r.by);
    lines.push(
      `pull request #${pr.number}${approvals.length ? `, approved by ${approvals.join(', ')}` : ', no approvals'}`,
    );
  }
  if (p.bypass) lines.push('a ruleset was bypassed');
  lines.push(`${p.changesets.length} changeset${p.changesets.length === 1 ? '' : 's'}`);
  return lines;
}
