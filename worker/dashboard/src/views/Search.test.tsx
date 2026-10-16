import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { SearchView } from './Search';

afterEach(() => vi.unstubAllGlobals());

function mount(entry = '/search') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/search" element={<SearchView />} />
      </Routes>
    </MemoryRouter>,
  );
}

function stub() {
  const fetcher = vi.fn(async (input: string) => {
    if (input.startsWith('/api/v1/search/paths'))
      return Response.json({
        files: [
          {
            repo: 'acme/api',
            path: 'src/server.ts',
            lang: 'typescript',
            size: 40,
            cs: 'c1',
          },
        ],
        truncated: false,
      });
    return Response.json({
      results: [
        {
          repo: 'acme/api',
          path: 'src/server.ts',
          lang: 'typescript',
          cs: 'c1',
          blob: 'b1',
          matches: [
            { line: 2, text: 'export function startServer() {}', ranges: [[16, 27]] },
          ],
        },
      ],
      truncated: false,
      partial: true,
      skipped_repos: [],
    });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

it('searches code with filters and highlights matches', async () => {
  const fetcher = stub();
  mount();
  fireEvent.change(screen.getByLabelText('Search text'), {
    target: { value: 'start.*Server' },
  });
  fireEvent.change(screen.getByLabelText('Path'), { target: { value: 'src/' } });
  fireEvent.click(screen.getByLabelText('Regular expression'));
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  const mark = await screen.findByText('startServer');
  expect(mark.tagName).toBe('MARK');
  expect(screen.getByText('src/server.ts').getAttribute('href')).toBe(
    '/r/acme/api/tree/c1/src/server.ts',
  );
  expect(screen.getByText(/still being indexed/)).toBeTruthy();
  expect(fetcher.mock.calls[0]![0]).toBe(
    '/api/v1/search/code?q=start.*Server&path=src%2F&regex=1',
  );
});

it('finds files by path from the URL', async () => {
  const fetcher = stub();
  mount('/search?q=server&mode=files&repo=acme%2Fapi');
  expect(await screen.findByText('src/server.ts')).toBeTruthy();
  expect(fetcher.mock.calls[0]![0]).toBe('/api/v1/search/paths?q=server&repo=acme%2Fapi');
});
