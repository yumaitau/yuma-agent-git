import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TreeView } from './TreeView';

const HASH = 'ab'.repeat(32);

function treeResponse(): Response {
  return new Response(
    JSON.stringify({
      path: 'src',
      entries: [
        { name: 'lib', kind: 'tree', hash: HASH },
        { name: 'main.ts', kind: 'blob', hash: HASH, size: 42 },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TreeView', () => {
  it('renders a seeded tree fixture', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => treeResponse()),
    );
    render(
      <MemoryRouter initialEntries={['/r/acme/tools/tree/abc123/src']}>
        <Routes>
          <Route path="/r/:owner/:name/tree/:cs/*" element={<TreeView />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('main.ts')).toBeTruthy();
    expect(screen.getByText('lib/')).toBeTruthy();
    expect(screen.getByText('src')).toBeTruthy();
  });

  it('switches between branches and tags with the ref picker', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/refs')) {
        return new Response(
          JSON.stringify({
            refs: [
              { name: 'feature/foo-bar', head: HASH, updated_at: 1 },
              { name: 'main', head: HASH, updated_at: 1 },
              { name: 'refs/tags/v1.2.3', head: HASH, updated_at: 1 },
            ],
            next_cursor: null,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return treeResponse();
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <MemoryRouter initialEntries={['/r/acme/tools/tree/ref%3Amain/src']}>
        <Routes>
          <Route path="/r/:owner/:name/tree/:cs/*" element={<TreeView />} />
        </Routes>
      </MemoryRouter>,
    );
    const picker = (await screen.findByLabelText('Branch or tag')) as HTMLSelectElement;
    expect(picker.value).toBe('main');
    expect(screen.getByRole('option', { name: 'v1.2.3' })).toBeTruthy();

    fireEvent.change(picker, { target: { value: 'feature/foo-bar' } });
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes(encodeURIComponent('ref:feature/foo-bar')),
        ),
      ).toBe(true),
    );
  });
});
