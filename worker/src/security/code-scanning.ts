import { z } from 'zod';
import type { Env } from '../env';
import type { RepoRecord } from '../db/client';
import { q, q1 } from '../db/client';
import type { AuditActor } from '../audit/record';
import { ApiError } from '../core/errors';
import { sha256Hex } from '../core/hashing';
import { emitEvent } from '../webhooks/events';
import { severityOfScore, type Severity } from './deps/osv';

/**
 * Code scanning (issue #67): SARIF 2.1.0 from any scanner (Trivy, CodeQL,
 * Semgrep, Checkov) uploaded for a changeset on a ref. Each run in a file is
 * one analysis, keyed by tool and category. Alerts live per ref and are
 * deduplicated by fingerprint: an upload opens new ones, reopens fixed ones
 * it finds again, and fixes open ones of the same tool and category it no
 * longer finds. Dismissed alerts stay dismissed. Uploads apply in arrival
 * order, so a scanner uploads oldest commit first.
 */

/** Base64 text accepted (about 15 MiB of gzip, GitHub's limit is 10 MiB). */
export const MAX_SARIF_B64 = 20 * 1024 * 1024;
/** Decompressed SARIF accepted. */
export const MAX_SARIF_BYTES = 32 * 1024 * 1024;
/** Results accepted per upload, across its runs. */
export const MAX_RESULTS = 5_000;
/** Webhook events sent per upload and state change (larger changes are listed by the API). */
export const MAX_EVENTS = 100;

export const uploadSarifSchema = z.object({
  /** Git commit SHA-1 or changeset id the analysis ran on (a CI job's own when it uploads). */
  commit_sha: z
    .string()
    .regex(/^([0-9a-f]{40}|[0-9a-f]{64})$/)
    .optional(),
  /** Branch (`main`, `refs/heads/main`) or pull request ref (`refs/pull/7/head`). */
  ref: z.string().min(1).max(255).optional(),
  /** SARIF JSON, gzip compressed then base64 encoded (plain JSON in base64 is accepted too). */
  sarif: z.string().min(1).max(MAX_SARIF_B64),
  category: z.string().max(255).optional(),
  tool_name: z.string().min(1).max(100).optional(),
});
export type UploadSarif = z.infer<typeof uploadSarifSchema>;

const ruleSchema = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  shortDescription: z.looseObject({ text: z.string().optional() }).optional(),
  defaultConfiguration: z.looseObject({ level: z.string().optional() }).optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
});
const driverSchema = z.looseObject({
  name: z.string().min(1),
  rules: z.array(ruleSchema).optional(),
});
const regionSchema = z.looseObject({
  startLine: z.int().optional(),
  endLine: z.int().optional(),
  startColumn: z.int().optional(),
  endColumn: z.int().optional(),
});
const resultSchema = z.looseObject({
  ruleId: z.string().optional(),
  ruleIndex: z.int().optional(),
  rule: z
    .looseObject({
      id: z.string().optional(),
      index: z.int().optional(),
      toolComponent: z.looseObject({ index: z.int().optional() }).optional(),
    })
    .optional(),
  level: z.string().optional(),
  message: z.looseObject({
    text: z.string().optional(),
    markdown: z.string().optional(),
  }),
  locations: z
    .array(
      z.looseObject({
        physicalLocation: z
          .looseObject({
            artifactLocation: z.looseObject({ uri: z.string().optional() }).optional(),
            region: regionSchema.optional(),
          })
          .optional(),
      }),
    )
    .optional(),
  fingerprints: z.record(z.string(), z.string()).optional(),
  partialFingerprints: z.record(z.string(), z.string()).optional(),
});
export const sarifSchema = z.looseObject({
  version: z.literal('2.1.0'),
  runs: z
    .array(
      z.looseObject({
        tool: z.looseObject({
          driver: driverSchema,
          extensions: z.array(driverSchema).optional(),
        }),
        automationDetails: z.looseObject({ id: z.string().optional() }).optional(),
        results: z.array(resultSchema).nullable().optional(),
      }),
    )
    .min(1)
    .max(20),
});
export type Sarif = z.infer<typeof sarifSchema>;
type Rule = z.infer<typeof ruleSchema>;
type Result = z.infer<typeof resultSchema>;

/** Base64 → bytes → gunzip (bounded) → JSON → SARIF 2.1.0. */
export async function decodeSarif(text: string): Promise<Sarif> {
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(text.replace(/\s+/g, '')), (ch) => ch.charCodeAt(0));
  } catch {
    throw new ApiError(400, 'invalid_sarif', 'sarif must be base64 encoded');
  }
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await gunzip(bytes);
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError(400, 'invalid_sarif', 'sarif is not JSON');
  }
  const parsed = sarifSchema.safeParse(json);
  if (!parsed.success)
    throw new ApiError(400, 'invalid_sarif', 'sarif is not a SARIF 2.1.0 log', {
      issues: parsed.error.issues.slice(0, 5).map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
  return parsed.data;
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BufferSource])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > MAX_SARIF_BYTES)
        throw new ApiError(413, 'sarif_too_large', 'Decompressed SARIF is over 32 MiB.');
      chunks.push(chunk);
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(400, 'invalid_sarif', 'sarif gzip data is corrupt');
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

export interface Finding {
  fingerprint: string;
  rule_id: string;
  rule_name: string | null;
  severity: Severity;
  message: string;
  path: string;
  start_line: number | null;
  end_line: number | null;
  start_column: number | null;
  end_column: number | null;
}

export interface Analysis {
  tool: string;
  category: string;
  findings: Finding[];
}

/** A repository-relative path from a SARIF artifact URI. */
function pathOf(uri: string | undefined): string {
  if (!uri) return '';
  let path = uri.replace(/^file:\/\/[^/]*/, '');
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep the raw text
  }
  return path
    .replace(/^(\.\/|\/)+/, '')
    .slice(0, 1024)
    .normalize('NFC');
}

/**
 * Severity: a rule's `security-severity` (CVSS score, as CodeQL and Trivy
 * set it), else the level: `error` high, `warning` medium, `note` low.
 */
function severityOf(result: Result, rule: Rule | undefined): Severity {
  const score = Number(rule?.properties?.['security-severity']);
  if (rule?.properties?.['security-severity'] !== undefined && Number.isFinite(score))
    return severityOfScore(score);
  const level = result.level ?? rule?.defaultConfiguration?.level ?? 'warning';
  return level === 'error' ? 'high' : level === 'warning' ? 'medium' : 'low';
}

/** `category/run-id` names the category before the last slash, as GitHub reads it. */
function categoryOf(id: string | undefined): string {
  if (!id) return '';
  return id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : id;
}

/**
 * Fingerprint: the tool's own (`fingerprints`, else `partialFingerprints`
 * such as CodeQL's `primaryLocationLineHash`), else rule, path, line and
 * message. Hashed with the rule id so tools cannot collide across rules.
 */
async function fingerprintOf(result: Result, f: Omit<Finding, 'fingerprint'>) {
  const own = (fps: Record<string, string> | undefined): string | null => {
    const keys = Object.keys(fps ?? {}).sort();
    return keys.length ? keys.map((k) => `${k}=${fps![k]}`).join('\n') : null;
  };
  const source =
    own(result.fingerprints) ??
    own(result.partialFingerprints) ??
    `${f.path}\n${f.start_line ?? ''}\n${f.message}`;
  return sha256Hex(new TextEncoder().encode(`${f.rule_id}\n${source}`));
}

export async function analysesOf(
  sarif: Sarif,
  overrides: { category?: string; tool_name?: string } = {},
): Promise<Analysis[]> {
  const out: Analysis[] = [];
  let total = 0;
  for (const run of sarif.runs) {
    const components = [run.tool.driver, ...(run.tool.extensions ?? [])];
    const byId = new Map<string, Rule>();
    for (const c of components) for (const r of c.rules ?? []) byId.set(r.id, r);
    const findings = new Map<string, Finding>();
    for (const result of run.results ?? []) {
      if (++total > MAX_RESULTS)
        throw new ApiError(
          413,
          'too_many_results',
          `An upload holds at most ${MAX_RESULTS} results.`,
        );
      const component = components[result.rule?.toolComponent?.index ?? 0];
      const index = result.ruleIndex ?? result.rule?.index;
      const indexed = index === undefined ? undefined : component?.rules?.[index];
      const ruleId = result.ruleId ?? result.rule?.id ?? indexed?.id ?? 'unknown';
      const rule = byId.get(ruleId) ?? indexed;
      const location = result.locations?.[0]?.physicalLocation;
      const region = location?.region;
      const finding = {
        rule_id: ruleId.slice(0, 255),
        rule_name:
          (rule?.shortDescription?.text ?? rule?.name ?? null)?.slice(0, 500) ?? null,
        severity: severityOf(result, rule),
        message: (result.message.text ?? result.message.markdown ?? '').slice(0, 4000),
        path: pathOf(location?.artifactLocation?.uri),
        start_line: region?.startLine ?? null,
        end_line: region?.endLine ?? region?.startLine ?? null,
        start_column: region?.startColumn ?? null,
        end_column: region?.endColumn ?? null,
      };
      const fingerprint = await fingerprintOf(result, finding);
      findings.set(fingerprint, { fingerprint, ...finding });
    }
    out.push({
      tool: (overrides.tool_name ?? run.tool.driver.name).slice(0, 100),
      category: (overrides.category ?? categoryOf(run.automationDetails?.id)).slice(
        0,
        255,
      ),
      findings: [...findings.values()],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export const alertRowSchema = z.object({
  id: z.number(),
  ref: z.string(),
  tool: z.string(),
  category: z.string(),
  fingerprint: z.string(),
  rule_id: z.string(),
  rule_name: z.string().nullable(),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  message: z.string(),
  path: z.string(),
  start_line: z.number().nullable(),
  end_line: z.number().nullable(),
  start_column: z.number().nullable(),
  end_column: z.number().nullable(),
  state: z.enum(['open', 'fixed', 'dismissed']),
  dismissed_reason: z.string().nullable(),
  dismissed_by: z.string().nullable(),
  last_analysis_id: z.number(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type CodeScanningAlert = z.infer<typeof alertRowSchema>;
export const ALERT_COLUMNS = Object.keys(alertRowSchema.shape).join(', ');

/** Forge ref name for an uploaded ref: `refs/heads/x` is the branch `x`. */
export function normaliseRef(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

export interface StoredAnalysis {
  id: number;
  tool: string;
  category: string;
  results: number;
  opened: number;
  reopened: number;
  fixed: number;
}

/** Store one upload's analyses, move alert states, then send webhook events. */
export async function ingestAnalyses(
  env: Env,
  repo: RepoRecord,
  at: { ref: string; csId: string },
  analyses: readonly Analysis[],
  actor: AuditActor,
  origin: string | null,
): Promise<StoredAnalysis[]> {
  const out: StoredAnalysis[] = [];
  const changed: { action: string; id: number }[] = [];
  for (const analysis of analyses) {
    const now = Date.now();
    const key = [repo.id, at.ref, analysis.tool, analysis.category];
    const created = await q1<{ id: number }>(
      env,
      `INSERT INTO code_scanning_analyses (repo_id, ref, cs_id, tool, category, results, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [
        ...key.slice(0, 2),
        at.csId,
        ...key.slice(2),
        analysis.findings.length,
        actor.id,
        now,
      ],
    );
    const id = created!.id;
    const before = new Map(
      (
        await q<{ id: number; fingerprint: string; state: string }>(
          env,
          `SELECT id, fingerprint, state FROM code_scanning_alerts
            WHERE repo_id = ? AND ref = ? AND tool = ? AND category = ?`,
          key,
        )
      ).map((r) => [r.fingerprint, r]),
    );
    const stored: StoredAnalysis = {
      id,
      tool: analysis.tool,
      category: analysis.category,
      results: analysis.findings.length,
      opened: 0,
      reopened: 0,
      fixed: 0,
    };
    const writes: D1PreparedStatement[] = analysis.findings.map((f) =>
      env.DB.prepare(
        `INSERT INTO code_scanning_alerts (repo_id, ref, tool, category, fingerprint, rule_id, rule_name,
           severity, message, path, start_line, end_line, start_column, end_column, state,
           last_analysis_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)
         ON CONFLICT (repo_id, ref, tool, category, fingerprint) DO UPDATE SET
           rule_id = excluded.rule_id, rule_name = excluded.rule_name, severity = excluded.severity,
           message = excluded.message, path = excluded.path, start_line = excluded.start_line,
           end_line = excluded.end_line, start_column = excluded.start_column,
           end_column = excluded.end_column, last_analysis_id = excluded.last_analysis_id,
           state = CASE WHEN state = 'fixed' THEN 'open' ELSE state END,
           updated_at = excluded.updated_at`,
      ).bind(
        ...key,
        f.fingerprint,
        f.rule_id,
        f.rule_name,
        f.severity,
        f.message,
        f.path,
        f.start_line,
        f.end_line,
        f.start_column,
        f.end_column,
        id,
        now,
        now,
      ),
    );
    for (let i = 0; i < writes.length; i += 100)
      await env.DB.batch(writes.slice(i, i + 100));
    const found = new Set(analysis.findings.map((f) => f.fingerprint));
    const gone = [...before.values()].filter(
      (a) => a.state === 'open' && !found.has(a.fingerprint),
    );
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO code_scanning_results (analysis_id, alert_id)
         SELECT ?, id FROM code_scanning_alerts
          WHERE repo_id = ? AND ref = ? AND tool = ? AND category = ? AND last_analysis_id = ?`,
      ).bind(id, ...key, id),
      env.DB.prepare(
        `UPDATE code_scanning_alerts SET state = 'fixed', updated_at = ?
          WHERE repo_id = ? AND ref = ? AND tool = ? AND category = ? AND state = 'open'
            AND last_analysis_id != ?`,
      ).bind(now, ...key, id),
    ]);
    stored.fixed = gone.length;
    for (const a of gone) changed.push({ action: 'fixed', id: a.id });
    const ids = new Map(
      (
        await q<{ id: number; fingerprint: string }>(
          env,
          `SELECT a.id, a.fingerprint FROM code_scanning_results r
             JOIN code_scanning_alerts a ON a.id = r.alert_id WHERE r.analysis_id = ?`,
          [id],
        )
      ).map((r) => [r.fingerprint, r.id]),
    );
    for (const f of analysis.findings) {
      const prior = before.get(f.fingerprint);
      const alertId = ids.get(f.fingerprint);
      if (alertId === undefined) continue;
      if (!prior) {
        stored.opened++;
        changed.push({ action: 'created', id: alertId });
      } else if (prior.state === 'fixed') {
        stored.reopened++;
        changed.push({ action: 'reopened', id: alertId });
      }
    }
    out.push(stored);
  }
  const counts = new Map<string, number>();
  for (const c of changed) {
    const n = (counts.get(c.action) ?? 0) + 1;
    counts.set(c.action, n);
    if (n > MAX_EVENTS) continue;
    const row = await q1(
      env,
      `SELECT ${ALERT_COLUMNS} FROM code_scanning_alerts WHERE id = ?`,
      [c.id],
    );
    if (!row) continue;
    await emitEvent(env, repo, {
      event: 'code_scanning_alert',
      action: c.action,
      actor,
      origin,
      data: { alert: alertRowSchema.parse(row), commit: at.csId },
    });
  }
  return out;
}

/**
 * Findings at `headCs` (the latest analysis per tool and category on it),
 * each marked `new` when the target ref holds no open or dismissed alert
 * with its fingerprint.
 */
export async function pullFindings(
  env: Env,
  repoId: string,
  baseRef: string,
  headCs: string,
): Promise<(CodeScanningAlert & { new: boolean })[]> {
  const rows = await q(
    env,
    `SELECT ${ALERT_COLUMNS.split(', ')
      .map((c) => `a.${c}`)
      .join(', ')},
            NOT EXISTS (SELECT 1 FROM code_scanning_alerts b
              WHERE b.repo_id = a.repo_id AND b.ref = ? AND b.tool = a.tool
                AND b.category = a.category AND b.fingerprint = a.fingerprint
                AND b.state IN ('open', 'dismissed')) AS is_new
       FROM code_scanning_results r
       JOIN code_scanning_alerts a ON a.id = r.alert_id
      WHERE r.analysis_id IN (
        SELECT MAX(id) FROM code_scanning_analyses
         WHERE repo_id = ? AND cs_id = ? GROUP BY tool, category)
      ORDER BY a.id LIMIT 1000`,
    [baseRef, repoId, headCs],
  );
  return rows.map((r) => ({
    ...alertRowSchema.parse(r),
    new: (r as { is_new: number }).is_new === 1,
  }));
}
