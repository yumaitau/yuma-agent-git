import { describe, expect, it } from 'vitest';
import { parseReferences, renderMarkdown } from '../shared/markdown';

describe('parseReferences', () => {
  it('finds local, cross-repo and closing references once each', () => {
    expect(
      parseReferences(
        'Closes #12. Fixes: yuma/app#3, see #12 and resolved #4.\nAlso fix #5',
      ),
    ).toEqual([
      { repo: null, number: 12, closes: true },
      { repo: 'yuma/app', number: 3, closes: true },
      { repo: null, number: 4, closes: true },
      { repo: null, number: 5, closes: true },
    ]);
  });

  it('ignores code, URLs, words and paths', () => {
    expect(
      parseReferences(
        'a#1 https://x.io/a/b#2 src/a/b#3 `#4`\n```\nCloses #5\n```\n(#6) &#7;',
      ),
    ).toEqual([{ repo: null, number: 6, closes: false }]);
  });

  it('only treats the keyword right before the reference as closing', () => {
    expect(parseReferences('This fixes things in #8')).toEqual([
      { repo: null, number: 8, closes: false },
    ]);
  });
});

describe('renderMarkdown', () => {
  it('renders the common subset with reference links', () => {
    const html = renderMarkdown(
      '# Title\n\nSome **bold** and *em* `code`, see #3 and [docs](https://x.io).\n\n- [x] done\n- [ ] todo\n\n1. one\n\n> quoted\n\n```\nlet a = 1 < 2;\n```',
      { referenceHref: ({ repo, number }) => `/r/${repo ?? 'o/r'}/issues/${number}` },
    );
    expect(html).toBe(
      [
        '<h1>Title</h1>',
        '<p>Some <strong>bold</strong> and <em>em</em> <code>code</code>, see <a href="/r/o/r/issues/3">#3</a> and <a href="https://x.io" rel="noopener noreferrer">docs</a>.</p>',
        '<ul><li class="task">☑ done</li><li class="task">☐ todo</li></ul>',
        '<ol><li>one</li></ol>',
        '<blockquote>quoted</blockquote>',
        '<pre><code>let a = 1 &lt; 2;</code></pre>',
      ].join('\n'),
    );
  });

  it('strips script tags, event handlers and unsafe links (XSS)', () => {
    const attacks = [
      '<script>alert(1)</script>',
      '<img src=x onerror="alert(1)">',
      '<a href="javascript:alert(1)">x</a>',
      '[click](javascript:alert(1))',
      '[click](JaVaScRiPt:alert(1))',
      '[click](data:text/html,<script>alert(1)</script>)',
      '[x](https://ok.io" onmouseover="alert(1))',
      'https://ok.io/"onmouseover="alert(1)',
      '<svg/onload=alert(1)>',
      '**<iframe src=//evil>**',
      '# <body onload=alert(1)>',
      '- <style>*{}</style>',
    ];
    for (const attack of attacks) {
      const html = renderMarkdown(attack);
      expect(html, attack).not.toMatch(/<(script|img|svg|iframe|body|style)/i);
      expect(html, attack).not.toMatch(/<[^>]+\son\w+=/i);
      expect(html, attack).not.toMatch(/href="(?!https?:|\/|#)/i);
    }
    expect(renderMarkdown('[a](https://x.io/?a="b")')).toContain(
      'href="https://x.io/?a=&quot;b&quot;"',
    );
  });
});
