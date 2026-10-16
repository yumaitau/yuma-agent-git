import type { Env } from '../env';
import { getRef } from '../db/repos';
import { dagMergeBases } from '../core/ancestry';
import { pullFindings, type CodeScanningAlert } from './code-scanning';
import { newVulnerableDependencies, type Match } from './deps/graph';

/**
 * Security findings on a pull request (issue #67): code scanning results
 * uploaded for its head changeset, `new` when the target branch holds no
 * open or dismissed alert with the same fingerprint, and vulnerable
 * dependencies the head pins that the merge base did not.
 */
export interface PullSecurity {
  code_scanning: (CodeScanningAlert & { new: boolean })[];
  dependencies: Match[];
}

export async function pullSecurity(
  env: Env,
  pull: { repo_id: string; base_ref: string; head_cs: string },
): Promise<PullSecurity> {
  const target = await getRef(env, pull.repo_id, pull.base_ref);
  const base = target
    ? ((await dagMergeBases(env, pull.repo_id, target.head, pull.head_cs)).bases[0] ??
      null)
    : null;
  return {
    code_scanning: await pullFindings(env, pull.repo_id, pull.base_ref, pull.head_cs),
    dependencies: await newVulnerableDependencies(env, pull.repo_id, base, pull.head_cs),
  };
}

/** What a `security_alerts` ruleset rule counts: new, undismissed findings. */
export async function newSecurityAlerts(
  env: Env,
  pull: { repo_id: string; base_ref: string; head_cs: string },
): Promise<{ severity: string; title: string }[]> {
  const found = await pullSecurity(env, pull);
  return [
    ...found.code_scanning
      .filter((a) => a.new && a.state !== 'dismissed')
      .map((a) => ({
        severity: a.severity,
        title: `${a.rule_id}${a.path ? ` in ${a.path}` : ''}`,
      })),
    ...found.dependencies.map((d) => ({
      severity: d.severity,
      title: `${d.advisory_id} in ${d.name}@${d.version}`,
    })),
  ];
}
