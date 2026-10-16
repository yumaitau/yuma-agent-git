import { expect, it } from 'vitest';
import html from '../index.html?raw';
import css from './theme.css?raw';

const TOKENS = [
  'bg',
  'bg-soft',
  'panel',
  'panel-2',
  'border',
  'border-soft',
  'fg',
  'fg-strong',
  'muted',
  'faint',
  'accent',
  'accent-soft',
  'ok',
  'ok-soft',
  'warn',
  'warn-soft',
  'danger',
  'danger-soft',
  'mono',
  'sans',
  'radius',
];

it('keeps every existing theme token name', () => {
  for (const token of TOKENS) expect(css).toContain(`--${token}:`);
});

it('records the brand source of every colour token', () => {
  const lines = css
    .split('\n')
    .filter((line) => /^\s+--[\w-]+: .*#[0-9a-f]{3,8}\b/i.test(line));
  expect(lines.length).toBeGreaterThan(20);
  for (const line of lines) expect(line, line).toMatch(/\/\* site /);
});

it('ships the Yuma Git title, favicon and Google-only web fonts', () => {
  expect(html).toContain('<title>Yuma Git</title>');
  expect(html).toContain('href="/favicon.svg"');
  const external = [...html.matchAll(/href="(https:[^"]+)"/g)].map(
    (m) => new URL(m[1]).host,
  );
  expect(
    external.every(
      (host) => host.endsWith('fonts.googleapis.com') || host === 'fonts.gstatic.com',
    ),
  ).toBe(true);
});
