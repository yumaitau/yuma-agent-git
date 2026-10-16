import { ApiError } from './errors';

/**
 * A linear-time matcher for code search regexes (issue #45). V8's RegExp
 * backtracks, so a pattern such as `((a+))+$` or `.*.*.*x` takes exponential
 * or high polynomial time on one line. This is a Pike VM (a Thompson NFA run
 * with thread priorities): each line costs at most pattern size times line
 * length, and it finds the same leftmost-first matches as RegExp.
 *
 * It takes JavaScript syntax (without the `u` flag) except look-around and
 * back-references, which no automaton can run in linear time. Every search
 * shares one step budget, so even linear work stays bounded per request.
 */

/** Steps (thread visits) one search may spend matching. */
export const MAX_MATCH_STEPS = 50_000_000;
/** Instructions a compiled pattern may have (counted repetition expands). */
const MAX_INSTRUCTIONS = 5_000;

export class MatchBudgetError extends Error {
  constructor() {
    super('the search spent its matching budget');
    this.name = 'MatchBudgetError';
  }
}

export interface LineMatcher {
  test(line: string): boolean;
  /** `[start, end)` of non-empty matches, left to right, at most `max`. */
  ranges(line: string, max: number): [number, number][];
}

type Pred = (c: number) => boolean;
type Assertion = '^' | '$' | 'b' | 'B';
type Node =
  | { t: 'pred'; pred: Pred }
  | { t: 'assert'; kind: Assertion }
  | { t: 'cat'; items: Node[] }
  | { t: 'alt'; items: Node[] }
  | { t: 'rep'; node: Node; min: number; max: number; lazy: boolean };
/** Try `x` first, then `y`. */
type Split = { op: 'split'; x: number; y: number };
type Jump = { op: 'jmp'; x: number };
type Inst =
  | { op: 'char'; pred: Pred; next: number }
  | Split
  | Jump
  | { op: 'assert'; kind: Assertion; next: number }
  | { op: 'match' };

const unsupported = (what: string): ApiError =>
  new ApiError(400, 'invalid_pattern', `${what} are not supported in code search`);

const isWord = (c: number): boolean =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isDigit = (c: number): boolean => c >= 48 && c <= 57;
const isSpace = (c: number): boolean =>
  (c >= 9 && c <= 13) ||
  c === 32 ||
  c === 0xa0 ||
  c === 0x1680 ||
  (c >= 0x2000 && c <= 0x200a) ||
  c === 0x2028 ||
  c === 0x2029 ||
  c === 0x202f ||
  c === 0x205f ||
  c === 0x3000 ||
  c === 0xfeff;
const isLineEnd = (c: number): boolean =>
  c === 10 || c === 13 || c === 0x2028 || c === 0x2029;

const CLASS_ESCAPES: Record<string, Pred> = {
  d: isDigit,
  D: (c) => !isDigit(c),
  w: isWord,
  W: (c) => !isWord(c),
  s: isSpace,
  S: (c) => !isSpace(c),
};
const CONTROL_ESCAPES: Record<string, number> = {
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  0: 0,
};

function fold(c: number, to: 'toLowerCase' | 'toUpperCase'): number {
  const s = String.fromCharCode(c)[to]();
  return s.length === 1 ? s.charCodeAt(0) : c;
}

class Parser {
  private i = 0;
  constructor(
    private readonly src: string,
    private readonly ignoreCase: boolean,
  ) {}

  parse(): Node {
    const node = this.alt();
    if (this.i < this.src.length) throw unsupported('unbalanced parentheses');
    return node;
  }

  private peek(): string | undefined {
    return this.src[this.i];
  }

  private pred(p: Pred): Node {
    if (!this.ignoreCase) return { t: 'pred', pred: p };
    return {
      t: 'pred',
      pred: (c) => p(c) || p(fold(c, 'toLowerCase')) || p(fold(c, 'toUpperCase')),
    };
  }

  private alt(): Node {
    const items = [this.cat()];
    while (this.peek() === '|') {
      this.i++;
      items.push(this.cat());
    }
    return items.length === 1 ? (items[0] as Node) : { t: 'alt', items };
  }

  private cat(): Node {
    const items: Node[] = [];
    while (this.i < this.src.length && this.peek() !== '|' && this.peek() !== ')') {
      const atom = this.atom();
      items.push(this.quantified(atom));
    }
    return { t: 'cat', items };
  }

  /** `{n}`, `{n,}` or `{n,m}` at the cursor, or null (then `{` is a literal). */
  private braces(): { min: number; max: number } | null {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(this.src.slice(this.i));
    if (!m) return null;
    this.i += m[0].length;
    const min = Number(m[1]);
    const max = m[2] === undefined ? min : m[3] ? Number(m[3]) : Infinity;
    return { min, max };
  }

  private quantified(node: Node): Node {
    let bounds: { min: number; max: number } | null = null;
    const ch = this.peek();
    if (ch === '*') bounds = { min: 0, max: Infinity };
    else if (ch === '+') bounds = { min: 1, max: Infinity };
    else if (ch === '?') bounds = { min: 0, max: 1 };
    if (bounds) this.i++;
    else if (ch === '{') bounds = this.braces();
    if (!bounds) return node;
    const lazy = this.peek() === '?';
    if (lazy) this.i++;
    return { t: 'rep', node, ...bounds, lazy };
  }

  private atom(): Node {
    const ch = this.src[this.i++] as string;
    if (ch === '.') return { t: 'pred', pred: (c) => !isLineEnd(c) };
    if (ch === '^') return { t: 'assert', kind: '^' };
    if (ch === '$') return { t: 'assert', kind: '$' };
    if (ch === '[') return this.charClass();
    if (ch === '(') {
      if (this.peek() === '?') {
        const kind = this.src.slice(this.i, this.i + 3);
        if (kind.startsWith('?:')) this.i += 2;
        else if (/^\?<[A-Za-z_$]/.test(kind)) this.i = this.src.indexOf('>', this.i) + 1;
        else throw unsupported('look-around assertions');
      }
      const inner = this.alt();
      if (this.src[this.i++] !== ')') throw unsupported('unbalanced parentheses');
      return inner;
    }
    if (ch === '\\') return this.escape();
    const code = ch.charCodeAt(0);
    return this.pred((c) => c === code);
  }

  private escape(): Node {
    const ch = this.src[this.i++] as string;
    if (ch === 'b' || ch === 'B') return { t: 'assert', kind: ch };
    if (/[1-9]/.test(ch) || ch === 'k') throw unsupported('back-references');
    const cls = CLASS_ESCAPES[ch];
    if (cls) return { t: 'pred', pred: cls };
    const code = this.escapedChar(ch);
    return this.pred((c) => c === code);
  }

  /** The character an escape (after the backslash) stands for. */
  private escapedChar(ch: string): number {
    if (ch in CONTROL_ESCAPES) return CONTROL_ESCAPES[ch] as number;
    const hex = (n: number): number | null => {
      const digits = this.src.slice(this.i, this.i + n);
      if (!new RegExp(`^[0-9A-Fa-f]{${n}}$`).test(digits)) return null;
      this.i += n;
      return parseInt(digits, 16);
    };
    if (ch === 'x') return hex(2) ?? 120;
    if (ch === 'u') return hex(4) ?? 117;
    if (ch === 'c' && /[A-Za-z]/.test(this.peek() ?? '')) {
      return (this.src.charCodeAt(this.i++) as number) % 32;
    }
    return ch.charCodeAt(0);
  }

  private charClass(): Node {
    const negate = this.peek() === '^';
    if (negate) this.i++;
    const parts: Pred[] = [];
    // as in RegExp, `[]` matches nothing and `[^]` anything
    while (this.i < this.src.length && this.peek() !== ']') {
      const lo = this.classAtom();
      if (
        typeof lo === 'number' &&
        this.peek() === '-' &&
        this.src[this.i + 1] !== undefined &&
        this.src[this.i + 1] !== ']'
      ) {
        this.i++;
        const hi = this.classAtom();
        if (typeof hi === 'number') {
          parts.push((c) => c >= lo && c <= hi);
          continue;
        }
        parts.push(
          (c) => c === lo,
          (c) => c === 45,
          hi,
        );
        continue;
      }
      parts.push(typeof lo === 'number' ? (c) => c === lo : lo);
    }
    this.i++; // ]
    const inClass = (c: number): boolean => parts.some((p) => p(c));
    const folded: Pred = this.ignoreCase
      ? (c) =>
          inClass(c) || inClass(fold(c, 'toLowerCase')) || inClass(fold(c, 'toUpperCase'))
      : inClass;
    return { t: 'pred', pred: negate ? (c) => !folded(c) : folded };
  }

  /** One class member: a character code, or a predicate for `\d` and friends. */
  private classAtom(): number | Pred {
    const ch = this.src[this.i++] as string;
    if (ch !== '\\') return ch.charCodeAt(0);
    const next = this.src[this.i++] as string;
    const cls = CLASS_ESCAPES[next];
    if (cls) return cls;
    if (next === 'b') return 8;
    return this.escapedChar(next);
  }
}

function compile(root: Node): Inst[] {
  const prog: Inst[] = [];
  const push = <T extends Inst>(inst: T): T => {
    if (prog.length >= MAX_INSTRUCTIONS)
      throw new ApiError(400, 'invalid_pattern', 'the pattern is too large to search');
    prog.push(inst);
    return inst;
  };
  const split = (): Split => push<Split>({ op: 'split', x: 0, y: 0 });
  const emit = (node: Node): void => {
    switch (node.t) {
      case 'pred':
        push({ op: 'char', pred: node.pred, next: prog.length + 1 });
        return;
      case 'assert':
        push({ op: 'assert', kind: node.kind, next: prog.length + 1 });
        return;
      case 'cat':
        for (const item of node.items) emit(item);
        return;
      case 'alt': {
        // split(first, split(second, ... last)), each branch jumping to the end
        const jumps: Jump[] = [];
        node.items.forEach((item, k) => {
          const fork = k < node.items.length - 1 ? split() : null;
          if (fork) fork.x = prog.length;
          emit(item);
          if (fork) {
            jumps.push(push<Jump>({ op: 'jmp', x: 0 }));
            fork.y = prog.length;
          }
        });
        for (const jump of jumps) jump.x = prog.length;
        return;
      }
      case 'rep': {
        const { min, max, lazy } = node;
        // greedy takes another round first, lazy skips first
        const choose = (fork: Split, take: number, skip: number): void => {
          fork.x = lazy ? skip : take;
          fork.y = lazy ? take : skip;
        };
        for (let k = 0; k < min; k++) emit(node.node);
        if (max === Infinity) {
          const loop = split();
          const start = prog.length - 1;
          emit(node.node);
          push<Jump>({ op: 'jmp', x: start });
          choose(loop, start + 1, prog.length);
          return;
        }
        const optional: { fork: Split; take: number }[] = [];
        for (let k = min; k < max; k++) {
          const fork = split();
          optional.push({ fork, take: prog.length });
          emit(node.node);
        }
        for (const { fork, take } of optional) choose(fork, take, prog.length);
        return;
      }
    }
  };
  emit(root);
  push({ op: 'match' });
  return prog;
}

/** Compile `source` (already accepted by `new RegExp`) into a linear-time matcher. */
export function linearMatcher(
  source: string,
  ignoreCase: boolean,
  budget: { steps: number } = { steps: MAX_MATCH_STEPS },
): LineMatcher {
  const prog = compile(new Parser(source, ignoreCase).parse());
  const mark = new Uint32Array(prog.length);
  let gen = 0;

  /** Leftmost-first match at or after `from`; with `first`, any match will do. */
  const exec = (s: string, from: number, first: boolean): [number, number] | null => {
    const len = s.length;
    const add = (
      pcs: number[],
      starts: number[],
      pc: number,
      start: number,
      pos: number,
    ) => {
      if (mark[pc] === gen) return;
      mark[pc] = gen;
      if (--budget.steps < 0) throw new MatchBudgetError();
      const inst = prog[pc] as Inst;
      if (inst.op === 'jmp') return add(pcs, starts, inst.x, start, pos);
      if (inst.op === 'split') {
        add(pcs, starts, inst.x, start, pos);
        return add(pcs, starts, inst.y, start, pos);
      }
      if (inst.op === 'assert') {
        const before = pos > 0 && isWord(s.charCodeAt(pos - 1));
        const after = pos < len && isWord(s.charCodeAt(pos));
        const holds =
          inst.kind === '^'
            ? pos === 0
            : inst.kind === '$'
              ? pos === len
              : inst.kind === 'b'
                ? before !== after
                : before === after;
        if (holds) add(pcs, starts, inst.next, start, pos);
        return;
      }
      pcs.push(pc);
      starts.push(start);
    };
    let matched: [number, number] | null = null;
    let pcs: number[] = [];
    let starts: number[] = [];
    gen++;
    for (let i = from; i <= len; i++) {
      if (matched === null) add(pcs, starts, 0, i, i);
      if (pcs.length === 0) {
        if (matched !== null) break;
        gen++;
        continue;
      }
      gen++;
      const nextPcs: number[] = [];
      const nextStarts: number[] = [];
      const c = i < len ? s.charCodeAt(i) : -1;
      for (let k = 0; k < pcs.length; k++) {
        const inst = prog[pcs[k] as number] as Inst;
        if (inst.op === 'match') {
          matched = [starts[k] as number, i];
          if (first) return matched;
          break; // lower-priority threads lose to this match
        }
        if (inst.op === 'char' && c >= 0 && inst.pred(c))
          add(nextPcs, nextStarts, inst.next, starts[k] as number, i + 1);
      }
      pcs = nextPcs;
      starts = nextStarts;
    }
    return matched;
  };

  return {
    test: (line) => exec(line, 0, true) !== null,
    ranges: (line, max) => {
      const out: [number, number][] = [];
      let pos = 0;
      while (pos <= line.length && out.length < max) {
        const m = exec(line, pos, false);
        if (!m) break;
        if (m[1] > m[0]) out.push(m);
        pos = m[1] > m[0] ? m[1] : m[0] + 1;
      }
      return out;
    },
  };
}
