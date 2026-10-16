/**
 * Log masking for CI secrets (issue #50). Every value injected into a job is
 * replaced with `***` in the build log, including:
 *   - the exact value, and each line of a multi-line value
 *   - its base64 forms (standard and URL-safe) at all three byte alignments,
 *     so `echo "$SECRET" | base64` and base64 inside a larger blob both match
 *   - its URL-encoded form
 *   - any of these split across lines (`base64` wraps at 76 columns; a job can
 *     print a value in pieces), by allowing a line break between characters.
 * Values shorter than MIN_MASK_LENGTH are not masked: they would blank out
 * ordinary log text. Secret writes reject them for that reason.
 */
export const MIN_MASK_LENGTH = 4;
const MIN_ENCODED_LENGTH = 6;
export const MASK = '***';

function b64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+$/, '');
}

/** The base64 characters that depend only on `value`, at each byte offset. */
function base64Forms(value: string): string[] {
  const bytes = new TextEncoder().encode(value);
  const forms: string[] = [];
  for (let offset = 0; offset < 3; offset++) {
    const padded = new Uint8Array(offset + bytes.length);
    padded.set(bytes, offset);
    const encoded = b64(padded);
    const start = Math.ceil((8 * offset) / 6);
    const end = Math.floor((8 * (offset + bytes.length)) / 6);
    const core = encoded.slice(start, end);
    forms.push(core, core.replace(/\+/g, '-').replace(/\//g, '_'));
  }
  return forms;
}

/** Every string that must not appear in a log for this secret value. */
export function maskForms(value: string): string[] {
  if (value.length < MIN_MASK_LENGTH) return [];
  const forms = new Set<string>([value]);
  for (const line of value.split(/\r?\n/)) {
    if (line.trim().length >= MIN_MASK_LENGTH) forms.add(line);
  }
  for (const form of [...base64Forms(value), encodeURIComponent(value)]) {
    if (form.length >= MIN_ENCODED_LENGTH) forms.add(form);
  }
  return [...forms];
}

function escapeChar(ch: string): string {
  return /[\\^$.*+?()[\]{}|/-]/.test(ch) ? `\\${ch}` : ch;
}

export interface Masker {
  /** Mask a chunk. Text that could start a value is held back until the next chunk. */
  push(chunk: string): string;
  /** Mask and return everything held back. */
  flush(): string;
  /** Mask a complete string (no streaming state). */
  mask(text: string): string;
}

export function createMasker(values: readonly string[]): Masker {
  const forms = [...new Set(values.flatMap(maskForms))].sort(
    (a, b) => b.length - a.length,
  );
  if (forms.length === 0) {
    return { push: (chunk) => chunk, flush: () => '', mask: (text) => text };
  }
  // A line break (and the CR before it) may separate any two characters.
  const source = forms
    .map((form) => [...form].map(escapeChar).join('(?:\\r?\\n)?'))
    .join('|');
  const pattern = new RegExp(source, 'g');
  // Longest possible match: every character followed by "\r\n".
  const hold = Math.max(...forms.map((form) => form.length * 3));
  const mask = (text: string): string => text.replace(pattern, MASK);
  let pending = '';
  return {
    mask,
    push(chunk) {
      const buffer = pending + chunk;
      let cut = Math.max(0, buffer.length - hold);
      pattern.lastIndex = 0;
      for (const match of buffer.matchAll(pattern)) {
        // never split a match across the emitted and held parts
        if (match.index < cut && match.index + match[0].length > cut) cut = match.index;
        if (match.index >= cut) break;
      }
      pending = buffer.slice(cut);
      return mask(buffer.slice(0, cut));
    },
    flush() {
      const rest = mask(pending);
      pending = '';
      return rest;
    },
  };
}
