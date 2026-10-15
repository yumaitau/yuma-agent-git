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
});
