import { describe, expect, it } from 'vitest';
import { auditEventHash, verifyAuditChain, type AuditEvent } from '../src/audit.js';

async function chain(count: number): Promise<AuditEvent[]> {
  const events: AuditEvent[] = [];
  const heads: Record<string, string> = {};
  for (let i = 1; i <= count; i++) {
    const org = i % 2 === 0 ? 'acme' : '_instance';
    const event: AuditEvent = {
      id: i,
      org_id: org,
      repo_id: null,
      actor_kind: 'user',
      actor_id: 'u1',
      on_behalf_of: null,
      action: 'ref.move',
      target: { ref: 'main', to: `cs${i}` },
      ip: null,
      user_agent: null,
      request_id: `r${i}`,
      at: 1_700_000_000_000 + i,
      prev_hash: heads[org] ?? '',
      hash: '',
    };
    event.hash = await auditEventHash(event);
    heads[org] = event.hash;
    events.push(event);
  }
  return events;
}

const lines = (events: AuditEvent[]): string[] => events.map((e) => JSON.stringify(e));

describe('yag audit verify', () => {
  it('accepts an intact chain across orgs', async () => {
    const result = await verifyAuditChain(lines(await chain(6)));
    expect(result).toMatchObject({ ok: true, events: 6 });
  });

  it('detects a modified event', async () => {
    const events = await chain(4);
    events[2] = { ...events[2], target: { ref: 'main', to: 'evil' } };
    expect(await verifyAuditChain(lines(events))).toEqual({
      ok: false,
      id: 3,
      reason: 'event modified: hash mismatch',
    });
  });

  it('detects a deleted event', async () => {
    const events = await chain(5);
    events.splice(1, 1); // drop acme's first event
    expect(await verifyAuditChain(lines(events))).toMatchObject({ ok: false, id: 4 });
  });
});
