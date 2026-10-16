import { useState } from 'react';
import type { ReactElement } from 'react';
import type { Pull, ReviewThread } from '../collaboration';
import { Markdown } from '../Markdown';
import { formatRelative } from '../ui';

/**
 * Line-level review (issue #39): a thread with its comments, replies,
 * resolution and suggested changes, and the box that starts one. Shown under
 * a diff line and in the pull request's thread list.
 */

export interface ThreadActions {
  slug: string;
  pull: Pull;
  names: Record<string, string>;
  busy: boolean;
  /** Runs a request, then refreshes the pull and its threads. */
  run: (path: string, method: 'POST' | 'PUT', body: unknown) => Promise<boolean>;
}

export function ThreadCard({
  thread,
  actions,
}: {
  thread: ReviewThread;
  actions: ThreadActions;
}): ReactElement {
  const { slug, pull, names, busy, run } = actions;
  const [reply, setReply] = useState('');
  const open = ['open', 'draft'].includes(pull.state);
  const base = `/repos/${slug}/pulls/${pull.id}`;
  const lines =
    thread.start_line === thread.end_line
      ? `line ${thread.end_line}`
      : `lines ${thread.start_line}–${thread.end_line}`;
  const appliable =
    open &&
    !thread.outdated &&
    thread.side === 'head' &&
    thread.anchor_cs === pull.head_cs;
  return (
    <div className="review-thread" aria-label={`Thread on ${thread.path} ${lines}`}>
      <div className="small muted">
        <span className="mono">{thread.path}</span> · {lines}
        {thread.side === 'base' ? ' (old)' : ''}
        {thread.outdated && <span className="chip warn">outdated</span>}
        {thread.resolved_at && (
          <span className="chip ok">
            resolved by {names[thread.resolved_by ?? ''] ?? thread.resolved_by}
          </span>
        )}
      </div>
      {thread.outdated && thread.snippet !== null && <pre>{thread.snippet}</pre>}
      {thread.comments.map((comment) => (
        <div key={comment.id}>
          <div className="small muted">
            <strong>{names[comment.author] ?? comment.author}</strong> ·{' '}
            {formatRelative(comment.created_at)}
          </div>
          <Markdown source={comment.body} slug={slug} />
          {comment.suggestion_patch !== null && appliable && (
            <button
              disabled={busy}
              onClick={() =>
                void run(`${base}/suggestions/apply`, 'POST', {
                  comment_ids: [comment.id],
                  head_cs: pull.head_cs,
                  revision: pull.revision,
                })
              }
            >
              Apply suggestion
            </button>
          )}
        </div>
      ))}
      {open && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void run(`${base}/threads/${thread.id}/replies`, 'POST', {
              body: reply,
            }).then((ok) => ok && setReply(''));
          }}
        >
          <input
            type="text"
            aria-label="Reply"
            placeholder="Reply"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
          />
          <button disabled={busy || !reply.trim()}>Reply</button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(`${base}/threads/${thread.id}/resolution`, 'PUT', {
                resolved: !thread.resolved_at,
              })
            }
          >
            {thread.resolved_at ? 'Unresolve' : 'Resolve'}
          </button>
        </form>
      )}
    </div>
  );
}

export interface Draft {
  path: string;
  side: 'base' | 'head';
  line: number;
  text: string;
}

export function NewThread({
  draft,
  actions,
  onClose,
}: {
  draft: Draft;
  actions: ThreadActions;
  onClose: () => void;
}): ReactElement {
  const { slug, pull, busy, run } = actions;
  const [body, setBody] = useState('');
  return (
    <form
      className="review-thread stack"
      onSubmit={(e) => {
        e.preventDefault();
        void run(`/repos/${slug}/pulls/${pull.id}/threads`, 'POST', {
          path: draft.path,
          side: draft.side,
          line: draft.line,
          body,
          head_cs: pull.head_cs,
          revision: pull.revision,
        }).then((ok) => ok && onClose());
      }}
    >
      <textarea
        aria-label={`Comment on line ${draft.line}`}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="row">
        <button className="primary" disabled={busy || !body.trim()}>
          Add comment
        </button>
        {draft.side === 'head' && (
          <button
            type="button"
            onClick={() =>
              setBody(
                (b) => `${b}${b ? '\n' : ''}\`\`\`suggestion\n${draft.text}\n\`\`\`\n`,
              )
            }
          >
            Suggest a change
          </button>
        )}
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}
