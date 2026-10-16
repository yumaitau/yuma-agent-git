import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChangesetView } from './ChangesetView';

const PARENT = 'a'.repeat(64);
const ID = 'b'.repeat(64);

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ChangesetView', () => {
  it('renders unified hunks from the diff RPC', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.includes('/diff')) {
          return json({
            from: PARENT,
            to: ID,
            merge_base: PARENT,
            files: [{ path: 'src/health.ts', kind: 'add' }],
            truncated: false,
            texts: [
              {
                path: 'src/health.ts',
                unified:
                  '@@ -0,0 +1,2 @@\n+export function health() {\n+  return { ok: true };\n',
              },
            ],
          });
        }
        return json({
          changeset: {
            id: ID,
            repo_id: 'repo1',
            first_parent: PARENT,
            parents: [PARENT],
            author: { name: 'Ada', email: 'ada@example.com' },
            message: 'add healthcheck',
            created_at: 1_700_000_000_000,
            changed_files: [
              { path: 'src/health.ts', op: 'add', hash: 'c'.repeat(64), size: 40 },
            ],
            root_tree: 'd'.repeat(64),
          },
        });
      }),
    );

    render(
      <MemoryRouter initialEntries={[`/r/acme/tools/cs/${ID}`]}>
        <Routes>
          <Route path="/r/:owner/:name/cs/:id" element={<ChangesetView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('add healthcheck')).toBeTruthy();
    expect(screen.getByText(/export function health/)).toBeTruthy();
    expect(screen.getByText(/@@ -0,0 \+1,2 @@/)).toBeTruthy();
  });

  it('names the agent, the person it acted for and the task', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({
          changeset: {
            id: ID,
            repo_id: 'repo1',
            first_parent: null,
            parents: [],
            author: { agent: 'agt_1' },
            message: 'agent change',
            created_at: 1_700_000_000_000,
            changed_files: [],
            root_tree: 'd'.repeat(64),
          },
          provenance: {
            agent_id: 'agt_1',
            agent_name: 'Codex',
            agent_kind: 'codex',
            on_behalf_of: 'u1',
            on_behalf_of_login: 'Justin',
            task_id: '42',
          },
        }),
      ),
    );

    render(
      <MemoryRouter initialEntries={[`/r/acme/tools/cs/${ID}`]}>
        <Routes>
          <Route path="/r/:owner/:name/cs/:id" element={<ChangesetView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('Codex on behalf of Justin, task #42')).toBeTruthy();
  });
});
