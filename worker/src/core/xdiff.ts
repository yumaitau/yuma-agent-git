/**
 * Dependency-free line diff: Myers O(ND) + unified-diff rendering.
 *
 * Byte-exact: lines are split keeping their terminators, so CRLF/LF survive
 * untouched, and a final line without a trailing newline is marked with the
 * standard `\ No newline at end of file` on the side(s) that lack it.
 */

export interface DiffOp {
  type: 'eq' | 'del' | 'ins';
  /** 0-based index into the old lines (eq/del). */
  a: number;
  /** 0-based index into the new lines (eq/ins). */
  b: number;
}

/**
 * Split into lines **with** terminators preserved (`'a\n'`, and `'b'` for an
 * unterminated final line). Keeping terminators is what makes the diff
 * byte-exact: CRLF vs LF lines compare unequal and survive verbatim, and a
 * trailing-newline change is a real edit instead of vanishing.
 */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  const lines = parts.map((part, i) => (i < parts.length - 1 ? `${part}\n` : part));
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Pathological-input guard: fall back to whole-region replacement past this D. */
const MAX_D = 2_000;

/**
 * Edit script turning `a` into `b` (Myers greedy + linear V trace per d,
 * backtracked). Common prefix/suffix trimmed first.
 */
export function diffOps(a: string[], b: string[]): DiffOp[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const ops: DiffOp[] = [];
  for (let i = 0; i < start; i++) ops.push({ type: 'eq', a: i, b: i });
  ops.push(...myers(a.slice(start, endA), b.slice(start, endB), start));
  for (let i = endA; i < a.length; i++) {
    ops.push({ type: 'eq', a: i, b: i + (b.length - a.length) });
  }
  return ops;
}

function myers(a: string[], b: string[], offset: number): DiffOp[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  const max = n + m;
  const limit = Math.min(max, MAX_D);
  const v = new Int32Array(2 * max + 1);
  const vOffset = max;
  // trace[d] = V snapshot before round d, covering k ∈ [-d, d] at offset d.
  const trace: Int32Array[] = [];

  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice(vOffset - d, vOffset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[vOffset + k - 1] < v[vOffset + k + 1])) {
        x = v[vOffset + k + 1];
      } else {
        x = v[vOffset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[vOffset + k] = x;
      if (x >= n && y >= m) {
        return backtrack(trace, d, n, m, offset);
      }
    }
  }

  // Past MAX_D edits: replace the middle wholesale (still correct, less minimal).
  const ops: DiffOp[] = [];
  for (let x = 0; x < n; x++) ops.push({ type: 'del', a: offset + x, b: offset });
  for (let y = 0; y < m; y++) ops.push({ type: 'ins', a: offset + n, b: offset + y });
  return ops;
}

function backtrack(
  trace: Int32Array[],
  dEnd: number,
  n: number,
  m: number,
  offset: number,
): DiffOp[] {
  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = dEnd; d >= 0; d--) {
    const v = trace[d] as Int32Array;
    const k = x - y;
    let prevK: number;
    if (d === 0) {
      prevK = 0;
    } else if (k === -d || (k !== d && v[k - 1 + d] < v[k + 1 + d])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = v[prevK + d] ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ type: 'eq', a: offset + x - 1, b: offset + y - 1 });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) {
        ops.push({ type: 'ins', a: offset + x, b: offset + y - 1 });
      } else {
        ops.push({ type: 'del', a: offset + x - 1, b: offset + y });
      }
    }
    x = prevX;
    y = prevY;
  }
  ops.reverse();
  return ops;
}

const NO_NEWLINE = '\\ No newline at end of file';

/**
 * Unified diff hunks (3 lines of context by default) for `oldText` → `newText`.
 * Returns `''` for identical inputs. No `---`/`+++` headers — callers know the
 * path — but the hunk headers are standard: `@@ -a,b +c,d @@`.
 */
export function unifiedDiff(oldText: string, newText: string, context = 3): string {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const ops = diffOps(a, b);

  const changed = ops.map((op) => op.type !== 'eq');
  if (!changed.some(Boolean)) return '';

  // Group changes whose equal-gap is ≤ 2×context (contexts would overlap).
  const groups: { start: number; end: number }[] = [];
  let i = 0;
  while (i < ops.length) {
    if (!changed[i]) {
      i++;
      continue;
    }
    const start = i;
    let end = i;
    let j = i + 1;
    while (j < ops.length) {
      if (changed[j]) {
        end = j;
        j++;
        continue;
      }
      // count equal run
      let gap = 0;
      let k = j;
      while (k < ops.length && !changed[k]) {
        gap++;
        k++;
      }
      if (k < ops.length && gap <= 2 * context) {
        end = k;
        j = k + 1;
        continue;
      }
      break;
    }
    groups.push({ start, end });
    i = end + 1;
  }

  const out: string[] = [];
  for (const group of groups) {
    const from = Math.max(0, group.start - context);
    const to = Math.min(ops.length, group.end + 1 + context);

    let aBefore = 0;
    let bBefore = 0;
    for (let idx = 0; idx < from; idx++) {
      const op = ops[idx] as DiffOp;
      if (op.type !== 'ins') aBefore++;
      if (op.type !== 'del') bBefore++;
    }

    let aCount = 0;
    let bCount = 0;
    const lines: string[] = [];
    for (let idx = from; idx < to; idx++) {
      const op = ops[idx] as DiffOp;
      const text = op.type === 'ins' ? (b[op.b] as string) : (a[op.a] as string);
      const prefix = op.type === 'eq' ? ' ' : op.type === 'del' ? '-' : '+';
      if (op.type !== 'ins') aCount++;
      if (op.type !== 'del') bCount++;
      lines.push(printLine(prefix, text));
    }

    const aStart = aCount === 0 ? aBefore : aBefore + 1;
    const bStart = bCount === 0 ? bBefore : bBefore + 1;
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@\n`);
    out.push(...lines);
  }
  return out.join('');
}

function printLine(prefix: string, text: string): string {
  if (text.endsWith('\n')) return `${prefix}${text}`;
  return `${prefix}${text}\n${NO_NEWLINE}\n`;
}
