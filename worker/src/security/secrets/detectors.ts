/**
 * Secret detectors (issue #66): pure functions over text, shared by push
 * protection, the commit RPC, the history scan and transcript redaction.
 *
 * Each detector is a regex over the provider's published token shape. Where a
 * shape has no prefix (AWS secret keys, Cloudflare API tokens) the detector
 * needs the variable name next to the value. The generic detector takes any
 * quoted value assigned to a secret-looking name, keeps only high-entropy
 * values and drops known placeholders (the allow-list below).
 *
 * Providers do not publish token checksums we can rely on, so no detector
 * validates one; formats are strict instead. Bump `DETECTORS_VERSION` when a
 * pattern changes, so alerts can say which set found them.
 */
export const DETECTORS_VERSION = '2026-10-16.1';

export interface Detector {
  id: string;
  name: string;
  /** Global regex. Capture group 1, when present, is the secret itself. */
  pattern: RegExp;
  /** Extra check on the secret (entropy, placeholders); default accepts. */
  accept?: (secret: string) => boolean;
}

export interface Finding {
  detector: string;
  /** 1-based line and column of the secret's first character. */
  line: number;
  column: number;
  start: number;
  end: number;
  /** The matched value; callers hash it and drop it, never store it. */
  secret: string;
}

/** Shannon entropy in bits per character. */
export function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Documentation keys and placeholder words that are never real secrets. */
const ALLOWED_VALUES = new Set([
  'AKIAIOSFODNN7EXAMPLE',
  'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
]);
const PLACEHOLDER =
  /example|sample|dummy|placeholder|changeme|change_me|redacted|your[_-]|xxxx|\*\*\*|<[^>]*>|\$\{|\{\{|process\.env|^(.)\1+$/i;

/** True when `value` is a documented example or an obvious placeholder. */
export function allowListed(value: string): boolean {
  return ALLOWED_VALUES.has(value) || PLACEHOLDER.test(value);
}

function highEntropy(value: string): boolean {
  if (allowListed(value)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((re) => re.test(value)).length;
  return classes >= 2 && entropy(value) >= 3.5;
}

const notAllowed = (value: string): boolean => !allowListed(value);

/** No token character on either side (`\b` treats `-` as a boundary). */
const END = '(?![A-Za-z0-9_-])';
const START = '(?<![A-Za-z0-9_-])';
// PEM body characters, and the literal `\n` / `\r` escapes of a key kept in a
// JSON or .env string; a dash only when it does not start the next `-----` line
const KEY_BODY = '(?:[A-Za-z0-9+/=\\s:,]|\\\\[nr]|-(?!----))*';

export const DETECTORS: Detector[] = [
  {
    id: 'aws_access_key_id',
    name: 'AWS access key ID',
    pattern: new RegExp(`${START}((?:AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})${END}`, 'g'),
    accept: notAllowed,
  },
  {
    id: 'aws_secret_access_key',
    name: 'AWS secret access key',
    pattern:
      /aws_?secret_?(?:access_?)?key["']?\s*[:=]\s*["']?([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+])/gi,
    accept: highEntropy,
  },
  {
    id: 'github_token',
    name: 'GitHub token',
    pattern: new RegExp(
      `${START}(gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59})${END}`,
      'g',
    ),
    accept: notAllowed,
  },
  {
    id: 'yag_token',
    name: 'Yuma Agent Git token',
    pattern: new RegExp(
      `${START}((?:yag|yagat|yagis|yagrt|yscim)_[0-9a-f]{40,64}|(?:yagreg|yagrun|yagclone|yagjob)_[A-Za-z0-9_-]{43})${END}`,
      'g',
    ),
  },
  {
    id: 'cloudflare_api_token',
    name: 'Cloudflare API token',
    pattern:
      /(?:cloudflare|cf)_?api_?token["']?\s*[:=]\s*["']?([A-Za-z0-9_-]{40})(?![A-Za-z0-9_-])/gi,
    accept: highEntropy,
  },
  {
    id: 'cloudflare_global_api_key',
    name: 'Cloudflare global API key',
    pattern:
      /(?:cloudflare|cf)_?api_?key["']?\s*[:=]\s*["']?([0-9a-f]{37})(?![0-9a-f])/gi,
    accept: notAllowed,
  },
  {
    id: 'cloudflare_origin_ca_key',
    name: 'Cloudflare Origin CA key',
    pattern: new RegExp(`${START}(v1\\.0-[0-9a-f]{24}-[0-9a-f]{146})${END}`, 'g'),
  },
  {
    id: 'private_key',
    name: 'Private key',
    // header, body and END line; the body stops at the next `-----`, so a
    // missing END line still matches the header and body (linear time)
    pattern: new RegExp(
      `-----BEGIN[A-Z0-9 ]{0,20} PRIVATE KEY(?: BLOCK)?-----${KEY_BODY}(?:-----END[A-Z0-9 ]{0,20} PRIVATE KEY(?: BLOCK)?-----)?`,
      'g',
    ),
    accept: (block) => {
      const body = block
        .replace(/\\[nr]/g, '\n')
        .replace(/-----[^-]+-----/g, '')
        .replace(/^[A-Za-z-]+:.*$/gm, '')
        .replace(/\s/g, '');
      return body.length >= 64 && /^[A-Za-z0-9+/=]+$/.test(body) && notAllowed(body);
    },
  },
  {
    id: 'slack_token',
    name: 'Slack token',
    pattern: new RegExp(
      `${START}(xox[abposr]-[0-9A-Za-z]{6,}(?:-[0-9A-Za-z]+){1,4}|xapp-[0-9]-[A-Z0-9]+-[0-9]+-[a-f0-9]{32,})${END}`,
      'g',
    ),
    accept: notAllowed,
  },
  {
    id: 'slack_webhook_url',
    name: 'Slack incoming webhook URL',
    pattern:
      /(https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{6,}\/B[A-Z0-9]{6,}\/[A-Za-z0-9]{24})(?![A-Za-z0-9])/g,
  },
  {
    id: 'stripe_secret_key',
    name: 'Stripe live secret key',
    pattern: new RegExp(`${START}((?:sk|rk)_live_[0-9A-Za-z]{24,247})${END}`, 'g'),
    accept: notAllowed,
  },
  {
    id: 'stripe_webhook_secret',
    name: 'Stripe webhook signing secret',
    pattern: new RegExp(`${START}(whsec_[0-9A-Za-z]{32,})${END}`, 'g'),
    accept: notAllowed,
  },
  {
    id: 'generic_secret',
    name: 'High-entropy secret',
    pattern:
      /(?:secret|token|passwd|password|api_?key|access_?key|private_?key|client_?secret|auth_?key)[A-Za-z0-9_.-]{0,32}["']?\s*[:=]\s*["']([A-Za-z0-9+/=_.~-]{20,200})["']/gi,
    accept: highEntropy,
  },
];

export const DETECTOR_NAMES: Record<string, string> = Object.fromEntries(
  DETECTORS.map((d) => [d.id, d.name]),
);

/** Text Git would treat as binary (a NUL in the first 8000 bytes) is not scanned. */
export function isBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 8000).includes(0);
}

/**
 * Every secret in `text`, in order. A generic finding inside a specific one
 * (a GitHub token assigned to `token = "…"`) is dropped.
 */
export function scanText(text: string): Finding[] {
  const found: Omit<Finding, 'line' | 'column'>[] = [];
  for (const detector of DETECTORS) {
    detector.pattern.lastIndex = 0;
    for (const match of text.matchAll(detector.pattern)) {
      const secret = match[1] ?? match[0];
      if (detector.accept && !detector.accept(secret)) continue;
      const start = match.index + (match[1] ? match[0].indexOf(secret) : 0);
      const end = start + secret.length;
      if (found.some((f) => start < f.end && f.start < end)) continue;
      found.push({ detector: detector.id, start, end, secret });
    }
  }
  if (found.length === 0) return [];
  found.sort((a, b) => a.start - b.start);
  // line numbers only when something was found: one pass, no index for clean text
  const out: Finding[] = [];
  let line = 1;
  let lineStart = 0;
  let at = 0;
  for (const f of found) {
    for (; at < f.start; at++) {
      if (text.charCodeAt(at) === 10) {
        line++;
        lineStart = at + 1;
      }
    }
    out.push({ ...f, line, column: f.start - lineStart + 1 });
  }
  return out;
}

/** `text` with every secret replaced by `[REDACTED:<detector>]`. */
export function redactSecrets(text: string): string {
  const found = scanText(text);
  if (found.length === 0) return text;
  let out = '';
  let at = 0;
  for (const f of found) {
    out += `${text.slice(at, f.start)}[REDACTED:${f.detector}]`;
    at = f.end;
  }
  return out + text.slice(at);
}

function decodeBase64(text: string): string | null {
  try {
    const bytes = Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));
    return isBinary(bytes)
      ? null
      : new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

function encodeBase64(text: string): string {
  let bin = '';
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Redact every string in a JSON-like value. `content_b64` fields (commit tool
 * input) are decoded, redacted and encoded again, so a secret an agent writes
 * to a file does not survive in its transcript either.
 */
export function redactDeep<T>(value: T): T {
  const walk = (v: unknown, key: string | null): unknown => {
    if (typeof v === 'string') {
      if (key === 'content_b64') {
        const text = decodeBase64(v);
        if (text === null) return v;
        const redacted = redactSecrets(text);
        return redacted === text ? v : encodeBase64(redacted);
      }
      return redactSecrets(v);
    }
    if (Array.isArray(v)) return v.map((item) => walk(item, null));
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, item]) => [k, walk(item, k)]));
    }
    return v;
  };
  return walk(value, null) as T;
}
