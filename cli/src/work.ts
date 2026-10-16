import { z } from 'zod';
import type { WorkItem } from './api.js';

/** `yag work` (issue #59): option parsing and output for the work queue. */
export const riskOption = z.enum(['low', 'medium', 'high']);
export const outcomeOption = z.enum(['ready', 'in-review', 'blocked', 'done']);
export const readinessOption = z.enum([
  'draft',
  'needs-prep',
  'ready',
  'in-review',
  'blocked',
  'done',
]);
export const secondsOption = z.coerce.number().int().min(30).max(3600);
export const numberOption = z.coerce.number().int().positive();

/** One line per item: `#12 ready low p3 Title (claimed by …, waits on #4)`. */
export function formatWorkItem(item: WorkItem): string {
  const notes = [
    item.claimed_by &&
      `claimed by ${item.claimed_by} until ${new Date(item.lease_expires_at ?? 0).toISOString()}`,
    item.waiting_on.length > 0 &&
      `waits on ${item.waiting_on.map((n) => `#${n}`).join(', ')}`,
    item.attempts > 0 && `${item.attempts} attempts`,
  ].filter(Boolean);
  return `#${item.number} ${item.readiness} ${item.risk} p${item.priority} ${item.title}${
    notes.length ? ` (${notes.join('; ')})` : ''
  }`;
}
