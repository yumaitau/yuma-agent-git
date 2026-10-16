import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ReleasesView } from './Releases';
import type { Release } from '../../../shared/releases';

afterEach(() => vi.unstubAllGlobals());

function mount() {
  return render(
    <MemoryRouter initialEntries={['/r/acme/tools/releases']}>
      <Routes>
        <Route path="/r/:owner/:name/releases" element={<ReleasesView />} />
      </Routes>
    </MemoryRouter>,
  );
}

const sha = 'ab'.repeat(32);
const release: Release = {
  id: 'rel_1',
  tag: 'v1.0.0',
  target_cs: 'c'.repeat(64),
  name: 'First',
  body: 'Hello notes',
  draft: true,
  prerelease: false,
  latest: false,
  created_by: 'user:u1',
  created_at: Date.now(),
  updated_at: Date.now(),
  published_at: null,
  assets: [
    {
      id: 'ast_1',
      name: 'app.tar.gz',
      content_type: 'application/gzip',
      size: 2048,
      sha256: sha,
      uploaded_by: 'user:u1',
      run_id: null,
      created_at: Date.now(),
    },
  ],
  attestations: [
    {
      id: 'att_1',
      run_id: 'run_1',
      key_id: 'k',
      subjects: [{ name: 'app.tar.gz', digest: { sha256: sha } }],
      created_by: 'user:u1',
      created_at: Date.now(),
    },
  ],
};

function stub() {
  const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (input.includes('/tags')) return Response.json({ tags: [{ name: 'v1.0.0' }] });
    if (input.endsWith('/generate-notes'))
      return Response.json({
        name: 'v1.0.0',
        body: '## Commits\n\n- abc seed',
        previous_tag: null,
        changesets: 1,
        pulls: [],
      });
    if (method === 'POST' && input.endsWith('/releases'))
      return Response.json({ release: { ...release, id: 'rel_2' } }, { status: 201 });
    if (method === 'POST' && input.includes('/assets'))
      return Response.json({ asset: release.assets[0] }, { status: 201 });
    if (method === 'PATCH')
      return Response.json({ release: { ...release, draft: false } });
    return Response.json({ releases: [release] });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

it('lists releases with checksummed assets and publishes a draft', async () => {
  const fetcher = stub();
  mount();
  expect(await screen.findByText('First')).toBeTruthy();
  expect(screen.getByText('draft')).toBeTruthy();
  expect(screen.getByText('provenance')).toBeTruthy();
  expect(screen.getByText(`sha256:${sha.slice(0, 16)}`)).toBeTruthy();
  const link = screen.getByText('app.tar.gz').closest('a')!;
  expect(link.getAttribute('href')).toBe(
    '/api/v1/repos/acme/tools/releases/rel_1/assets/ast_1',
  );
  fireEvent.click(screen.getByText('Publish'));
  await screen.findByText('Published v1.0.0.');
  const patch = fetcher.mock.calls.find(([, init]) => init?.method === 'PATCH');
  expect(patch![0]).toBe('/api/v1/repos/acme/tools/releases/rel_1');
  expect(JSON.parse(String(patch![1]!.body))).toEqual({ draft: false });
});

it('creates a release from a tag with generated notes and two assets', async () => {
  const fetcher = stub();
  mount();
  await screen.findByText('First');
  await waitFor(() =>
    expect((screen.getByLabelText('Tag') as HTMLSelectElement).value).toBe('v1.0.0'),
  );
  fireEvent.click(screen.getByText('Generate notes'));
  await waitFor(() =>
    expect((screen.getByLabelText('Notes') as HTMLTextAreaElement).value).toContain(
      '## Commits',
    ),
  );
  const files = [
    new File(['linux'], 'app-linux.tar.gz', { type: 'application/gzip' }),
    new File(['mac'], 'app-mac.tar.gz', { type: 'application/gzip' }),
  ];
  fireEvent.change(screen.getByLabelText('Assets'), { target: { files } });
  fireEvent.click(screen.getByText('Create release'));
  await screen.findByText('Release created.');
  const create = fetcher.mock.calls.find(
    ([url, init]) => init?.method === 'POST' && url.endsWith('/releases'),
  );
  expect(JSON.parse(String(create![1]!.body))).toMatchObject({
    tag: 'v1.0.0',
    draft: false,
  });
  const uploads = fetcher.mock.calls.filter(([url]) => url.includes('/assets?'));
  expect(
    uploads.map(([url]) => new URL(url, 'https://x').searchParams.get('name')),
  ).toEqual(['app-linux.tar.gz', 'app-mac.tar.gz']);
  expect(new URL(uploads[0]![0], 'https://x').searchParams.get('sha256')).toMatch(
    /^[0-9a-f]{64}$/,
  );
});
