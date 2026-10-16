import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { BoardView, columnOf } from './Board';
import type { WorkItem } from '../../../shared/work';
import { expectAccessible } from '../axe';

function item(number: number, extra: Partial<WorkItem> = {}): WorkItem {
  return {
    number,
    title: `Task ${number}`,
    state: 'open',
    readiness: 'ready',
    risk: 'low',
    size: null,
    agent_kind: null,
    priority: 0,
    plan: false,
    ready_at: 1,
    claimed_by: null,
    lease_expires_at: null,
    attempts: 0,
    depends_on: [],
    waiting_on: [],
    updated_at: 1,
    ...extra,
  };
}

afterEach(() => vi.unstubAllGlobals());

it('maps readiness, dependencies and attempts to board columns', () => {
  expect(columnOf(item(1, { readiness: 'needs-prep' }))).toBe('Needs preparation');
  expect(columnOf(item(2))).toBe('Queued');
  expect(columnOf(item(3, { waiting_on: [2] }))).toBe('Waiting');
  expect(columnOf(item(4, { readiness: 'blocked' }))).toBe('Waiting');
  expect(columnOf(item(5, { readiness: 'claimed' }))).toBe('Running');
  expect(columnOf(item(6, { readiness: 'in-review' }))).toBe('Review');
  expect(columnOf(item(7, { attempts: 3 }))).toBe('Needs attention');
  expect(columnOf(item(8, { readiness: 'done', attempts: 5 }))).toBe('Done');
});

it('shows the board in columns and filters by risk and agent', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        items: [
          item(1, { title: 'Queued low' }),
          item(2, {
            title: 'Running high',
            risk: 'high',
            readiness: 'claimed',
            claimed_by: 'agent:agt_1',
            lease_expires_at: Date.now() + 60_000,
          }),
          item(3, { title: 'Waiting medium', risk: 'medium', waiting_on: [1] }),
        ],
      }),
    ),
  );
  render(
    <MemoryRouter initialEntries={['/r/acme/tools/board']}>
      <Routes>
        <Route path="/r/:owner/:name/board" element={<BoardView />} />
      </Routes>
    </MemoryRouter>,
  );
  const queued = await screen.findByRole('region', { name: 'Queued' });
  await expectAccessible(document.body);
  expect(within(queued).getByText('Queued low')).toBeTruthy();
  const running = screen.getByRole('region', { name: 'Running' });
  expect(within(running).getByText('Running high')).toBeTruthy();
  expect(within(running).getByText(/agent:agt_1/)).toBeTruthy();
  const waiting = screen.getByRole('region', { name: 'Waiting' });
  expect(within(waiting).getByText('Waits on #1')).toBeTruthy();

  fireEvent.change(screen.getByLabelText('Risk'), { target: { value: 'high' } });
  expect(screen.queryByText('Queued low')).toBeNull();
  expect(screen.getByText('Running high')).toBeTruthy();

  fireEvent.change(screen.getByLabelText('Risk'), { target: { value: '' } });
  fireEvent.change(screen.getByLabelText('Agent'), { target: { value: 'agent:agt_1' } });
  expect(screen.queryByText('Waiting medium')).toBeNull();
  expect(screen.getByText('Running high')).toBeTruthy();
});
