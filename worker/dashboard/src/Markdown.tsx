import type { ReactElement } from 'react';
import { renderMarkdown } from '../../shared/markdown';

/**
 * Markdown from issues, pull requests and comments. `renderMarkdown` escapes
 * every source character and writes only its own tags, so the HTML is safe to
 * inject. `#N` links to the issue (a pull request number redirects there).
 */
export function Markdown({
  source,
  slug,
}: {
  source: string;
  slug: string;
}): ReactElement {
  const html = renderMarkdown(source, {
    referenceHref: ({ repo, number }) => `/r/${repo ?? slug}/issues/${number}`,
  });
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
