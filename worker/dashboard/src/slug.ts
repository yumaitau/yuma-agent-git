import { useParams } from 'react-router-dom';

/**
 * Repo slugs are `owner/name` (two path-safe segments) so routes are shaped
 * `/r/:owner/:name/...` — this stitches the slug back together.
 */
export function useSlug(): string {
  const { owner, name } = useParams();
  return `${owner ?? ''}/${name ?? ''}`;
}
