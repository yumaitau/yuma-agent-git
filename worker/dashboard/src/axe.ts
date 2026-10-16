import axe from 'axe-core';
import { expect } from 'vitest';

/**
 * Test helper (issue #80): fails on serious or critical axe-core (WCAG 2.2 AA)
 * violations in a rendered view. jsdom has no layout, so colour contrast is
 * left to the Playwright run against a real browser.
 */
export async function expectAccessible(container: Element): Promise<void> {
  const result = await axe.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] },
    rules: { 'color-contrast': { enabled: false } },
    resultTypes: ['violations'],
  });
  const blocking = result.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  expect(blocking).toEqual([]);
}
