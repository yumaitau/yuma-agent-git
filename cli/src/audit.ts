import { z } from 'zod';

/**
 * `yag audit verify` (issue #65): recompute the per-org hash chain of an
 * audit export. The hash covers these fields in this order; it must match
 * `worker/src/audit/record.ts`. Kept free of Node imports so the Worker test
 * suite can run this exact verifier against a real export.
 */
export const AUDIT_HASH_FIELDS = [
  'org_id',
  'repo_id',
  'actor_kind',
  'actor_id',
  'on_behalf_of',
  'action',
  'target',
  'ip',
  'user_agent',
  'request_id',
  'at',
  'prev_hash',
] as const;

export const auditEventSchema = z.object({
  id: z.number().int(),
  org_id: z.string(),
  repo_id: z.string().nullable(),
  actor_kind: z.string(),
  actor_id: z.string(),
  on_behalf_of: z.string().nullable(),
  action: z.string(),
  target: z.unknown(),
  ip: z.string().nullable(),
  user_agent: z.string().nullable(),
  request_id: z.string().nullable(),
  at: z.number().int(),
  prev_hash: z.string(),
  hash: z.string(),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

export async function auditEventHash(event: AuditEvent): Promise<string> {
  // `target` is stored as JSON text; the API returns it parsed
  const stored = {
    ...event,
    target:
      typeof event.target === 'string' ? event.target : JSON.stringify(event.target),
  };
  const canonical = JSON.stringify(AUDIT_HASH_FIELDS.map((field) => stored[field]));
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export type VerifyResult =
  | { ok: true; events: number; heads: Record<string, string> }
  | { ok: false; id: number; reason: string };

/** Verify NDJSON export lines (oldest first). Stops at the first broken link. */
export async function verifyAuditChain(lines: string[]): Promise<VerifyResult> {
  const heads: Record<string, string> = {};
  let count = 0;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const event = auditEventSchema.parse(JSON.parse(line));
    const expectedPrev = heads[event.org_id] ?? '';
    if (event.prev_hash !== expectedPrev) {
      return { ok: false, id: event.id, reason: 'chain broken: prev_hash mismatch' };
    }
    if ((await auditEventHash(event)) !== event.hash) {
      return { ok: false, id: event.id, reason: 'event modified: hash mismatch' };
    }
    heads[event.org_id] = event.hash;
    count++;
  }
  return { ok: true, events: count, heads };
}
