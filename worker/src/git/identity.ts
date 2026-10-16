import type { Author } from '../db/client';
import type { Changeset } from '../core/changesets';
import type { GitSignature } from './objects';

/**
 * Git identities for changeset authors (issue #30). Fixed and host
 * independent: a Git ID must never change because a deploy moved.
 *
 * Agents (`{agent: id}`) become `id <id@agents.yuma-agent-git>`, so provenance
 * (#58) can map a Git author back to the agent with `agentIdFromEmail`. The id
 * is the agent identity (`agt_…`, #57) for commits made with an agent token;
 * built-in task runs and older `agent:run` API tokens use their task or token id.
 */

export const AGENT_EMAIL_DOMAIN = 'agents.yuma-agent-git';
/** Users in commits the server makes for them (merges, #42): `login@users.yuma-agent-git`. */
export const USER_EMAIL_DOMAIN = 'users.yuma-agent-git';

export interface GitIdentity {
  name: string;
  email: string;
}

/** Git cannot store `<`, `>` or a newline inside an ident. */
function clean(text: string): string {
  return text.replace(/[<>\n]/g, '');
}

export function gitIdentity(author: Author): GitIdentity {
  if ('agent' in author) {
    const id = clean(author.agent);
    return { name: id, email: `${id}@${AGENT_EMAIL_DOMAIN}` };
  }
  return { name: clean(author.name), email: clean(author.email) };
}

export function agentIdFromEmail(email: string): string | null {
  const suffix = `@${AGENT_EMAIL_DOMAIN}`;
  return email.endsWith(suffix) ? email.slice(0, -suffix.length) : null;
}

/** Author and committer lines for a changeset; committer defaults to the author. */
export function commitSignatures(cs: Changeset): {
  author: GitSignature;
  committer: GitSignature;
} {
  const author: GitSignature = {
    ...gitIdentity(cs.author),
    seconds: Math.floor(cs.created_at / 1000),
    tz: cs.author_tz ?? '+0000',
  };
  const committer: GitSignature = cs.committer
    ? {
        name: clean(cs.committer.name),
        email: clean(cs.committer.email),
        seconds: Math.floor(cs.committer.at / 1000),
        tz: cs.committer_tz ?? '+0000',
      }
    : { ...author, tz: cs.committer_tz ?? author.tz };
  return { author, committer };
}
