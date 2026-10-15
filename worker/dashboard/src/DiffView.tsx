import type { ReactElement } from 'react';
import type { DiffFile, TextDiff } from './api';

/**
 * Unified-diff renderer. The diff RPC returns `texts: [{path, unified}]` where
 * `unified` has no `---`/`+++` headers — just standard `@@ -a,b +c,d @@` hunks
 * — so the file header comes from the file record instead.
 */

type LineKind = 'hunk' | 'add' | 'del' | 'ctx' | 'meta';

interface DiffLine {
  kind: LineKind;
  text: string;
}

export function parseUnified(unified: string): DiffLine[] {
  return unified.split('\n').map((line) => {
    if (line.startsWith('@@')) return { kind: 'hunk' as const, text: line };
    if (line.startsWith('---') || line.startsWith('+++')) {
      return { kind: 'meta' as const, text: line };
    }
    if (line.startsWith('+')) return { kind: 'add' as const, text: line };
    if (line.startsWith('-')) return { kind: 'del' as const, text: line };
    return { kind: 'ctx' as const, text: line };
  });
}

const SIGN: Record<LineKind, string> = {
  hunk: '',
  meta: '',
  add: '+',
  del: '-',
  ctx: ' ',
};

export function DiffBody({ unified }: { unified: string }): ReactElement {
  const lines = parseUnified(unified);
  return (
    <div className="diff-body">
      {lines.map((line, i) => (
        <div key={i} className={`diff-line ${line.kind === 'ctx' ? '' : line.kind}`}>
          <span className="sign">{SIGN[line.kind]}</span>
          <span className="txt">{line.text === '' ? '\u00a0' : line.text}</span>
        </div>
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
}: {
  file: DiffFile;
  text?: TextDiff;
  extra?: string;
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
        <DiffBody unified={text.unified} />
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
}: {
  files: DiffFile[];
  texts?: TextDiff[];
}): ReactElement {
  const byPath = new Map((texts ?? []).map((t) => [t.path, t]));
  return (
    <div>
      {files.map((file) => (
        <DiffFileCard
          key={`${file.side ?? ''}:${file.path}`}
          file={file}
          text={byPath.get(file.path)}
        />
      ))}
    </div>
  );
}
