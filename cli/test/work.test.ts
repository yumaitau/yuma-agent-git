import { describe, expect, it } from 'vitest';
import { ApiError, YagApi, type WorkItem } from '../src/api.js';
import { formatWorkItem, outcomeOption } from '../src/work.js';

const item: WorkItem = {
  number: 12,
  title: 'Add login',
  readiness: 'claimed',
  risk: 'low',
  priority: 3,
  claimed_by: 'agent:agt_1',
  lease_expires_at: Date.UTC(2026, 9, 16, 1, 0, 0),
  attempts: 1,
  waiting_on: [],
};

function fakeApi(respond: (req: Request) => Response): {
  api: YagApi;
  requests: Request[];
} {
  const requests: Request[] = [];
  const api = new YagApi({
    api: 'https://yag.test',
    repo: 'acme/app',
    token: 'yagat_x',
    fetchFn: async (input) => {
      const req = input as Request;
      requests.push(req);
      return respond(req);
    },
  });
  return { api, requests };
}

describe('yag work', () => {
  it('claims with a lease and risk cap, and reports an empty queue as null', async () => {
    const { api, requests } = fakeApi((req) =>
      Response.json({
        item: req.url.endsWith('/work/claim') && requests.length === 1 ? item : null,
      }),
    );
    expect(await api.claimWork({ lease_seconds: 300, max_risk: 'medium' })).toEqual(item);
    expect(await api.claimWork({})).toBeNull();
    const [first] = requests;
    expect(first!.method).toBe('POST');
    expect(first!.url).toBe('https://yag.test/api/v1/repos/acme/app/work/claim');
    expect(first!.headers.get('authorization')).toBe('Bearer yagat_x');
    expect(await first!.json()).toEqual({ lease_seconds: 300, max_risk: 'medium' });
  });

  it('sends heartbeats and releases, and surfaces a lost lease', async () => {
    const { api, requests } = fakeApi((req) =>
      req.url.endsWith('/heartbeat')
        ? Response.json(
            {
              error: {
                code: 'lease_lost',
                message: 'You do not hold a live claim on #12',
              },
            },
            { status: 409 },
          )
        : Response.json({ item: { ...item, readiness: 'in-review', claimed_by: null } }),
    );
    const released = await api.releaseWork(12, {
      outcome: 'in-review',
      reason: 'PR #13',
    });
    expect(released.readiness).toBe('in-review');
    expect(await requests[0]!.json()).toEqual({ outcome: 'in-review', reason: 'PR #13' });
    await expect(api.heartbeatWork(12, {})).rejects.toMatchObject({
      status: 409,
      code: 'lease_lost',
    } satisfies Partial<ApiError>);
    expect(requests[1]!.url).toBe(
      'https://yag.test/api/v1/repos/acme/app/work/12/heartbeat',
    );
  });

  it('lists with filters and prints one line per item', async () => {
    const { api, requests } = fakeApi(() =>
      Response.json({ items: [{ ...item, waiting_on: [4, 5] }] }),
    );
    const { items } = await api.listWork({ readiness: 'claimed', risk: undefined });
    expect(requests[0]!.url).toBe(
      'https://yag.test/api/v1/repos/acme/app/work?readiness=claimed',
    );
    expect(formatWorkItem(items[0]!)).toBe(
      '#12 claimed low p3 Add login (claimed by agent:agt_1 until 2026-10-16T01:00:00.000Z; waits on #4, #5; 1 attempts)',
    );
    expect(outcomeOption.safeParse('merged').success).toBe(false);
  });
});
