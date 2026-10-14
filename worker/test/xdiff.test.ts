import { describe, expect, it } from 'vitest';
import { diffOps, splitLines, unifiedDiff } from '../src/core/xdiff';

const nl = (lines: string[]): string[] => lines.map((l) => `${l}\n`);

describe('splitLines', () => {
  it('keeps terminators and distinguishes trailing-newline states', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a')).toEqual(['a']);
    expect(splitLines('a\n')).toEqual(['a\n']);
    expect(splitLines('a\nb')).toEqual(['a\n', 'b']);
    expect(splitLines('a\nb\n')).toEqual(['a\n', 'b\n']);
    expect(splitLines('\n')).toEqual(['\n']);
    // CRLF survives byte-exact (compare includes the \r)
    expect(splitLines('a\r\nb\r\n')).toEqual(['a\r\n', 'b\r\n']);
  });
});

describe('diffOps (Myers)', () => {
  it('handles empty vs lines and identical inputs', () => {
    expect(diffOps([], [])).toEqual([]);
    expect(diffOps(nl(['a', 'b']), nl(['a', 'b']))).toEqual([
      { type: 'eq', a: 0, b: 0 },
      { type: 'eq', a: 1, b: 1 },
    ]);
    expect(diffOps([], nl(['x']))).toEqual([{ type: 'ins', a: 0, b: 0 }]);
    expect(diffOps(nl(['x']), [])).toEqual([{ type: 'del', a: 0, b: 0 }]);
  });

  it('produces minimal edit scripts for scattered changes', () => {
    const a = nl(['a', 'b', 'c', 'd', 'e']);
    const b = nl(['a', 'B', 'c', 'd', 'E']);
    const ops = diffOps(a, b);
    expect(ops.filter((o) => o.type === 'del').map((o) => o.a)).toEqual([1, 4]);
    expect(ops.filter((o) => o.type === 'ins').map((o) => o.b)).toEqual([1, 4]);
    // reconstructs both sides in order
    expect(ops.filter((o) => o.type !== 'ins').map((o) => a[o.a])).toEqual(a);
    expect(ops.filter((o) => o.type !== 'del').map((o) => b[o.b])).toEqual(b);
  });

  it('is deterministic on larger inputs (2k lines, 50 changes)', () => {
    const a: string[] = [];
    const b: string[] = [];
    for (let i = 0; i < 2000; i++) {
      a.push(`line ${i}\n`);
      b.push(i % 40 === 7 ? `CHANGED ${i}\n` : `line ${i}\n`);
    }
    const first = diffOps(a, b);
    const second = diffOps(a, b);
    expect(first).toEqual(second);
    expect(first.filter((o) => o.type === 'del')).toHaveLength(50);
    expect(first.filter((o) => o.type === 'ins')).toHaveLength(50);
    expect(first.filter((o) => o.type === 'eq')).toHaveLength(1950);
  });
});

describe('unifiedDiff', () => {
  it('returns empty string for identical inputs', () => {
    expect(unifiedDiff('a\nb\n', 'a\nb\n')).toBe('');
    expect(unifiedDiff('', '')).toBe('');
    expect(unifiedDiff('x\r\ny\r\n', 'x\r\ny\r\n')).toBe('');
  });

  it('renders a single middle-line change with correct hunk headers', () => {
    const out = unifiedDiff('a\nb\nc\n', 'a\nB\nc\n');
    expect(out).toBe('@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n');
  });

  it('detects trailing-newline changes (regression: terminator-stripped split)', () => {
    const out = unifiedDiff('a\nb', 'a\nb\n');
    expect(out).toBe('@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n');
    const out2 = unifiedDiff('a\nb\n', 'a\nb');
    expect(out2).toBe('@@ -1,2 +1,2 @@\n a\n-b\n+b\n\\ No newline at end of file\n');
  });

  it('marks unterminated final lines on the correct side only', () => {
    const out = unifiedDiff('x\nb', 'y\nb');
    // shared unterminated last line is context WITH the marker; no marker noise
    expect(out).toBe('@@ -1,2 +1,2 @@\n-x\n+y\n b\n\\ No newline at end of file\n');
  });

  it('handles whole-file add and delete', () => {
    expect(unifiedDiff('', 'one\ntwo\n')).toBe('@@ -0,0 +1,2 @@\n+one\n+two\n');
    expect(unifiedDiff('one\ntwo\n', '')).toBe('@@ -1,2 +0,0 @@\n-one\n-two\n');
  });

  it('adds at end and deletes at start with correct starts', () => {
    expect(unifiedDiff('a\n', 'a\nb\n')).toBe('@@ -1,1 +1,2 @@\n a\n+b\n');
    expect(unifiedDiff('a\nb\n', 'b\n')).toBe('@@ -1,2 +1,1 @@\n-a\n b\n');
  });

  it('preserves CRLF byte-exactly', () => {
    const out = unifiedDiff('a\r\nb\r\n', 'a\r\nc\r\n');
    expect(out).toBe('@@ -1,2 +1,2 @@\n a\r\n-b\r\n+c\r\n');
  });

  it('merges nearby change groups and splits distant ones', () => {
    const a = nl(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    const b = nl(['1', 'X', '3', '4', '5', '6', '7', '8', 'Y', '10']);
    const out = unifiedDiff(a.join(''), b.join(''));
    // changes at lines 2 and 9: 6 equal lines between → with context 3 the
    // windows touch → single hunk
    expect(out.split('@@').length - 1).toBe(2);
    const far = nl([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '10',
      '11',
      '12',
      '13',
      '14',
      '15',
    ]);
    const farB = nl([
      'X',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '10',
      '11',
      '12',
      '13',
      '14',
      'Y',
    ]);
    const farOut = unifiedDiff(far.join(''), farB.join(''));
    expect(farOut.split('@@').length - 1).toBe(4); // two hunks, two headers each
  });
});
