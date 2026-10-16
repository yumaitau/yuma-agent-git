import { Fragment, type ReactElement, type ReactNode } from 'react';
import type { DiffFile, TextDiff } from './api';

/**
 * Unified-diff renderer. The diff RPC returns `texts: [{path, unified}]` where
 * `unified` has no `---`/`+++` headers — just standard `@@ -a,b +c,d @@` hunks
 * — so the file header comes from the file record instead.
 */

type LineKind = 'hunk' | 'add' | 'del' | 'ctx' | 'meta';

/** A diff line's place in a file: the proposed (`head`) or the old (`base`) side. */
export interface LineAnchor {
  side: 'base' | 'head';
  line: number;
  /** The line's text without its diff sign. */
  text: string;
}

interface DiffLine {
  kind: LineKind;
  text: string;
  anchor?: LineAnchor;
}

export function parseUnified(unified: string): DiffLine[] {
  let oldLine = 0;
  let newLine = 0;
  return unified.split('\n').map((line) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return { kind: 'hunk' as const, text: line };
    }
    if (line.startsWith('---') || line.startsWith('+++')) {
      return { kind: 'meta' as const, text: line };
    }
    const text = line.slice(1);
    if (line.startsWith('+'))
      return {
        kind: 'add' as const,
        text: line,
        anchor: { side: 'head', line: newLine++, text },
      };
    if (line.startsWith('-'))
      return {
        kind: 'del' as const,
        text: line,
        anchor: { side: 'base', line: oldLine++, text },
      };
    if (!line.startsWith(' ')) return { kind: 'ctx' as const, text: line };
    oldLine++;
    return {
      kind: 'ctx' as const,
      text: line,
      anchor: { side: 'head', line: newLine++, text },
    };
  });
}

/** Inline review on a diff (issue #39): start a comment on a line, show threads under it. */
export interface LineReview {
  onLine: (anchor: LineAnchor) => void;
  below: (anchor: LineAnchor) => ReactNode;
}

const SIGN: Record<LineKind, string> = {
  hunk: '',
  meta: '',
  add: '+',
  del: '-',
  ctx: ' ',
};

export function DiffBody({
  unified,
  review,
}: {
  unified: string;
  review?: LineReview;
}): ReactElement {
  const lines = parseUnified(unified);
  return (
    <div className="diff-body">
      {lines.map((line, i) => (
        <Fragment key={i}>
          <div className={`diff-line ${line.kind === 'ctx' ? '' : line.kind}`}>
            {review &&
              (line.anchor ? (
                <button
                  type="button"
                  className="ln"
                  aria-label={`Comment on ${line.anchor.side === 'base' ? 'old ' : ''}line ${line.anchor.line}`}
                  onClick={() => line.anchor && review.onLine(line.anchor)}
                >
                  {line.anchor.line}
                </button>
              ) : (
                <span className="ln" />
              ))}
            <span className="sign">{SIGN[line.kind]}</span>
            <span className="txt">{line.text === '' ? '\u00a0' : line.text}</span>
          </div>
          {review && line.anchor && review.below(line.anchor)}
        </Fragment>
      ))}
    </div>
  );
}

const KIND_LABEL: Record<DiffFile['kind'], string> = {
  add: 'added',
  del: 'deleted',
  mod: 'modified',
};

export function DiffFileCard({
  file,
  text,
  extra,
  review,
}: {
  file: DiffFile;
  text?: TextDiff;
  extra?: string;
  review?: LineReview;
}): ReactElement {
  return (
    <div className="diff-file">
      <div className="head">
        <span className="mono wrap-any grow">{file.path}</span>
        {file.side && <span className="chip info">{file.side}-side</span>}
        <span className="chip">{KIND_LABEL[file.kind]}</span>
        {extra && <span className="small faint">{extra}</span>}
      </div>
      {text ? (
        <DiffBody unified={text.unified} review={review} />
      ) : (
        <div className="small muted" style={{ padding: '8px 12px' }}>
          {file.kind === 'del'
            ? 'binary or oversized file — no text diff'
            : 'no text diff (binary or oversized file)'}
        </div>
      )}
    </div>
  );
}

/** Whole-diff view: file cards joined with their unified texts where present. */
export function DiffView({
  files,
  texts,
  review,
}: {
  files: DiffFile[];
  texts?: TextDiff[];
  /** Inline review for a file's lines (pull requests); omit for read-only diffs. */
  review?: (file: DiffFile) => LineReview | undefined;
}): ReactElement {
  const byPath = new Map((texts ?? []).map((t) => [t.path, t]));
  return (
    <div>
      {files.map((file) => (
        <DiffFileCard
          key={`${file.side ?? ''}:${file.path}`}
          file={file}
          text={byPath.get(file.path)}
          review={review?.(file)}
        />
      ))}
    </div>
  );
}
