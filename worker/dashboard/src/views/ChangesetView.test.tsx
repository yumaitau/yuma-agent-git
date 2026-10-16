import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChangesetView } from './ChangesetView';
import { expectAccessible } from '../axe';

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
    await expectAccessible(document.body);
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
    await expectAccessible(document.body);
  });

  it('shows the signature, signed provenance and a transcript link', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.includes('/provenance'))
          return json({
            records: [
              {
                id: 'p1',
                ref: 'main',
                new_cs: ID,
                via: 'merge',
                bypass: false,
                verified: true,
                reason: null,
                created_at: 1,
              },
            ],
            signature: {
              status: 'verified',
              format: 'x509',
              key_id: '07',
              signer: 'ada@example.com (https://accounts.example.com)',
              user_login: 'ada',
              reason: null,
            },
            sessions: [
              {
                id: 's1',
                agent_id: null,
                task_id: null,
                model: 'claude-opus-5-5',
                harness: 'claude-code',
                tools: [],
                started_at: 1,
                transcript_available: true,
              },
            ],
          });
        return json({
          changeset: {
            id: ID,
            repo_id: 'repo1',
            first_parent: null,
            parents: [],
            author: { name: 'Ada', email: 'ada@example.com' },
            message: 'signed change',
            created_at: 1_700_000_000_000,
            changed_files: [],
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

    expect(await screen.findByText('Verified')).toBeTruthy();
    await expectAccessible(document.body);
    expect(screen.getByText('x509 · ada')).toBeTruthy();
    expect(screen.getByText('Signed provenance')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'transcript' }).getAttribute('href')).toBe(
      '/api/v1/repos/acme/tools/sessions/s1/transcript',
    );
  });
});
