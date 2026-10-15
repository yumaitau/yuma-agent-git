import { render, screen } from '@testing-library/react';
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
});
