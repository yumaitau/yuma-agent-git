/**
 * Markdown rendering and `#N` reference parsing shared by issues, pull
 * requests and review comments (issues #38, #39). No runtime or platform
 * imports: the Worker and the dashboard both load this file.
 *
 * Rendering is escape-first: every character of the source goes through
 * `escapeHtml` and only the tags this file writes reach the output, so raw
 * HTML (scripts, event handlers, iframes) always renders as text. Links keep
 * only http(s), mailto and same-site targets.
 */

export interface Reference {
  /** `owner/name` for cross-repo references, null for the current repo. */
  repo: string | null;
  number: number;
  /** Preceded by a closing keyword (`Closes`, `Fixes`, `Resolves`). */
  closes: boolean;
}

const KEYWORD = '(close[sd]?|fix(?:e[sd])?|resolve[sd]?)';
const SLUG = '[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+';
// The look-behind stops matches inside words, URLs and paths (`a#1`, `/x#1`).
const REFERENCE_RE = new RegExp(
  `(?:\\b${KEYWORD}:?\\s+)?(?<![\\w/#&.-])(${SLUG})?#(\\d{1,9})\\b`,
  'gi',
);

/** Code is never scanned for references. */
function withoutCode(text: string): string {
  return text.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

/** Every `#N` / `owner/name#N` in `text`, deduplicated, in first-seen order. */
export function parseReferences(text: string): Reference[] {
  const found = new Map<string, Reference>();
  for (const match of withoutCode(text).matchAll(REFERENCE_RE)) {
    const repo = match[2] ?? null;
    const number = Number(match[3]);
    if (number < 1) continue;
    const key = `${repo?.toLowerCase() ?? ''}#${number}`;
    const prior = found.get(key);
    if (prior) prior.closes ||= match[1] !== undefined;
    else found.set(key, { repo, number, closes: match[1] !== undefined });
  }
  return [...found.values()];
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeUrl(url: string): boolean {
  return /^(https?:\/\/|mailto:|\/(?!\/)|#)/i.test(url);
}

export interface RenderOptions {
  /** Link target for a reference; omit to leave references as plain text. */
  referenceHref?: (ref: { repo: string | null; number: number }) => string;
}

const INLINE_RE = new RegExp(
  [
    '`([^`\\n]+)`', // 1 code
    '\\[([^\\]\\n]+)\\]\\(([^)\\s]+)\\)', // 2 text, 3 url
    '(https?://[^\\s<>()]+[^\\s<>().,;:!?\'"])', // 4 autolink
    `(?<![\\w/#&.-])(${SLUG})?#(\\d{1,9})\\b`, // 5 repo, 6 number
    '\\*\\*([^*\\n]+)\\*\\*', // 7 strong
    '(?<![\\w*])[*_]([^*_\\n]+)[*_](?![\\w*])', // 8 emphasis
  ].join('|'),
  'g',
);

function inline(text: string, options: RenderOptions): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const at = m.index ?? 0;
    out += escapeHtml(text.slice(last, at));
    last = at + m[0].length;
    if (m[1] !== undefined) out += `<code>${escapeHtml(m[1])}</code>`;
    else if (m[2] !== undefined && m[3] !== undefined) {
      out += safeUrl(m[3])
        ? `<a href="${escapeHtml(m[3])}" rel="noopener noreferrer">${inline(m[2], {})}</a>`
        : escapeHtml(m[0]);
    } else if (m[4] !== undefined) {
      out += `<a href="${escapeHtml(m[4])}" rel="noopener noreferrer">${escapeHtml(m[4])}</a>`;
    } else if (m[6] !== undefined) {
      const href = options.referenceHref?.({ repo: m[5] ?? null, number: Number(m[6]) });
      out += href
        ? `<a href="${escapeHtml(href)}">${escapeHtml(m[0])}</a>`
        : escapeHtml(m[0]);
    } else if (m[7] !== undefined) out += `<strong>${inline(m[7], options)}</strong>`;
    else if (m[8] !== undefined) out += `<em>${inline(m[8], options)}</em>`;
  }
  return out + escapeHtml(text.slice(last));
}

/**
 * A safe subset of GitHub-flavoured Markdown: headings, paragraphs, fenced
 * code, block quotes, bullet, numbered and task lists, inline code, links,
 * bold, italics and references.
 */
export function renderMarkdown(source: string, options: RenderOptions = {}): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const html: string[] = [];
  let paragraph: string[] = [];
  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null;
  const flush = (): void => {
    if (paragraph.length) {
      html.push(`<p>${paragraph.map((l) => inline(l, options)).join('<br>')}</p>`);
      paragraph = [];
    }
    if (list) {
      html.push(`<${list.tag}>${list.items.join('')}</${list.tag}>`);
      list = null;
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      while (
        ++i < lines.length &&
        !(lines[i] as string).trimStart().startsWith(fence[1] as string)
      )
        code.push(lines[i] as string);
      html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const quote = /^>\s?(.*)$/.exec(line);
    const item = /^\s*(?:([-*+])|\d+[.)])\s+(.*)$/.exec(line);
    if (line.trim() === '') flush();
    else if (heading) {
      flush();
      const level = (heading[1] as string).length;
      html.push(`<h${level}>${inline(heading[2] as string, options)}</h${level}>`);
    } else if (quote) {
      flush();
      html.push(`<blockquote>${inline(quote[1] as string, options)}</blockquote>`);
    } else if (item) {
      if (paragraph.length) flush();
      const tag = item[1] ? 'ul' : 'ol';
      if (list && list.tag !== tag) flush();
      list ??= { tag, items: [] };
      const task = /^\[([ xX])\]\s+(.*)$/.exec(item[2] as string);
      list.items.push(
        task
          ? `<li class="task">${task[1] === ' ' ? '☐' : '☑'} ${inline(task[2] as string, options)}</li>`
          : `<li>${inline(item[2] as string, options)}</li>`,
      );
    } else {
      if (list) flush();
      paragraph.push(line);
    }
  }
  flush();
  return html.join('\n');
}
