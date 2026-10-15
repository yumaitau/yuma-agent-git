/**
 * Small regex-based syntax highlighter — highlight.js is not a dependency and
 * the SPA must stay within its bundle budget, so this is a hand-rolled
 * tokenizer for the languages that actually show up in code review:
 * JS/TS/JSX/TSX, JSON, CSS/HTML-ish, Markdown — with a safe generic fallback
 * (comments + strings + numbers) for everything else.
 *
 * Output is a flat token list rendered as React spans (never raw HTML).
 */

export interface Token {
  text: string;
  cls: string | null;
}

const JS_KEYWORDS = new Set([
  'abstract',
  'as',
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'declare',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'from',
  'function',
  'get',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'is',
  'keyof',
  'let',
  'namespace',
  'new',
  'null',
  'of',
  'private',
  'protected',
  'public',
  'readonly',
  'return',
  'satisfies',
  'set',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'type',
  'typeof',
  'undefined',
  'unknown',
  'var',
  'void',
  'while',
  'with',
  'yield',
]);

interface Rule {
  re: RegExp;
  cls: string;
}

/**
 * Rules are tried at the current scan position by anchoring the pattern with
 * sticky flags; order matters (comments/strings before keywords).
 */
const JS_RULES: Rule[] = [
  { re: /\/\/[^\n]*/y, cls: 'tok-c' },
  { re: /\/\*[\s\S]*?(?:\*\/|$)/y, cls: 'tok-c' },
  { re: /`(?:\\[\s\S]|\$\{[^}]*\}|[^\\`])*`?/y, cls: 'tok-s' },
  { re: /'(?:\\[\s\S]|[^\\'\n])*'?/y, cls: 'tok-s' },
  { re: /"(?:\\[\s\S]|[^\\"\n])*"?/y, cls: 'tok-s' },
  { re: /\b0[xXbBoO][0-9a-fA-F_]+\b/y, cls: 'tok-n' },
  { re: /\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y, cls: 'tok-n' },
  { re: /[A-Za-z_$][\w$]*(?=\s*\()/y, cls: 'tok-t' },
  { re: /[A-Za-z_$][\w$]*/y, cls: 'kw' }, // keyword decided below
];

const JSON_RULES: Rule[] = [
  { re: /"(?:\\[\s\S]|[^\\"\n])*"\s*:/y, cls: 'tok-t' },
  { re: /"(?:\\[\s\S]|[^\\"\n])*"?/y, cls: 'tok-s' },
  { re: /\b(?:true|false|null)\b/y, cls: 'tok-k' },
  { re: /-?\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y, cls: 'tok-n' },
];

const CSS_RULES: Rule[] = [
  { re: /\/\*[\s\S]*?(?:\*\/|$)/y, cls: 'tok-c' },
  { re: /"(?:\\[\s\S]|[^\\"\n])*"?/y, cls: 'tok-s' },
  { re: /'(?:\\[\s\S]|[^\\'\n])*'?/y, cls: 'tok-s' },
  { re: /#[0-9a-fA-F]{3,8}\b/y, cls: 'tok-n' },
  { re: /@[\w-]+/y, cls: 'tok-k' },
  { re: /--[\w-]+/y, cls: 'tok-t' },
  { re: /\b\d[\d.]*(?:px|rem|em|%|vh|vw|s|ms|deg|fr)?\b/y, cls: 'tok-n' },
];

const MD_RULES: Rule[] = [
  { re: /^#{1,6}[^\n]*/my, cls: 'tok-k' },
  { re: /```[\s\S]*?(?:```|$)/y, cls: 'tok-s' },
  { re: /`[^`\n]*`/y, cls: 'tok-s' },
  { re: /\*\*[^*\n]+\*\*/y, cls: 'tok-t' },
  { re: /\[[^\]\n]*\]\([^)\n]*\)/y, cls: 'tok-t' },
];

const GENERIC_RULES: Rule[] = [
  { re: /#[^\n]*/y, cls: 'tok-c' },
  { re: /\/\/[^\n]*/y, cls: 'tok-c' },
  { re: /"(?:\\[\s\S]|[^\\"\n])*"?/y, cls: 'tok-s' },
  { re: /'(?:\\[\s\S]|[^\\'\n])*'?/y, cls: 'tok-s' },
  { re: /\b\d[\d_.]*\b/y, cls: 'tok-n' },
];

function rulesFor(lang: string): Rule[] {
  switch (lang) {
    case 'js':
    case 'jsx':
    case 'ts':
    case 'tsx':
    case 'mjs':
    case 'cjs':
      return JS_RULES;
    case 'json':
      return JSON_RULES;
    case 'css':
    case 'scss':
    case 'less':
      return CSS_RULES;
    case 'md':
    case 'markdown':
      return MD_RULES;
    default:
      return GENERIC_RULES;
  }
}

export function languageOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? '' : path.slice(dot + 1).toLowerCase();
}

/** Tokenize `code` for `lang` (extension, e.g. `ts`). Plain text → one token. */
export function tokenize(code: string, lang: string): Token[] {
  const rules = rulesFor(lang);
  const tokens: Token[] = [];
  let pos = 0;
  let plain = '';

  const flush = (): void => {
    if (plain !== '') {
      tokens.push({ text: plain, cls: null });
      plain = '';
    }
  };

  while (pos < code.length) {
    let matched = false;
    for (const rule of rules) {
      rule.re.lastIndex = pos;
      const m = rule.re.exec(code);
      if (!m || m.index !== pos || m[0] === '') continue;
      const text = m[0];
      if (rule.cls === 'kw') {
        // identifier: keyword only when it is in the keyword set
        flush();
        tokens.push({
          text,
          cls: JS_KEYWORDS.has(text) ? 'tok-k' : /^[A-Z]/.test(text) ? 'tok-t' : null,
        });
      } else {
        flush();
        tokens.push({ text, cls: rule.cls });
      }
      pos += text.length;
      matched = true;
      break;
    }
    if (!matched) {
      plain += code[pos];
      pos += 1;
    }
  }
  flush();
  return tokens;
}
