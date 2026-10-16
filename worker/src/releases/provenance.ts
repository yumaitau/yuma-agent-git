/**
 * SLSA build provenance (issue #54): an in-toto v1 statement whose predicate
 * follows SLSA provenance v1, built from a CI run and the forge-signed ID
 * token the run's job presented. The token proves the request came from
 * inside that job; the forge then signs the statement (provenance/dsse.ts).
 */

/** The audience a job requests for an attestation ID token. */
export const ATTEST_AUDIENCE = 'yag:attest';
export const BUILD_TYPE = 'urn:yuma-agent-git:ci-run:v1';

export interface Subject {
  name: string;
  digest: { sha256: string };
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export function buildProvenance(input: {
  origin: string;
  slug: string;
  claims: Record<string, unknown>;
  run: {
    id: string;
    head_cs: string;
    runner_id: string | null;
    started_at: number | null;
  };
  subjects: Subject[];
}): Record<string, unknown> {
  const { claims, run } = input;
  const issuer = str(claims.iss) ?? input.origin;
  const ref = str(claims.ref);
  const sha = str(claims.sha);
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: input.subjects,
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        buildType: BUILD_TYPE,
        externalParameters: {
          workflow: {
            repository: `${input.origin}/${input.slug}`,
            ref,
            job_workflow_ref: str(claims.job_workflow_ref),
          },
          event_name: str(claims.event_name),
          environment: str(claims.environment),
        },
        internalParameters: {
          job: str(claims.job),
          actor: str(claims.actor),
          actor_id: str(claims.actor_id),
          actor_kind: str(claims.actor_kind),
          // the OIDC identity the build presented
          oidc: { iss: issuer, sub: str(claims.sub), jti: str(claims.jti) },
        },
        resolvedDependencies: [
          {
            uri: `git+${input.origin}/${input.slug}.git${ref ? `@${ref}` : ''}`,
            digest: { ...(sha ? { gitCommit: sha } : {}), yagChangeset: run.head_cs },
          },
        ],
      },
      runDetails: {
        builder: {
          // self-hosted runners are a different trust boundary from the built-in pool
          id:
            run.runner_id === null || run.runner_id === 'cloudflare'
              ? `${issuer}/builders/cloudflare`
              : `${issuer}/builders/self-hosted/${run.runner_id}`,
        },
        metadata: {
          invocationId: `${input.origin}/r/${input.slug}/ci#${run.id}`,
          ...(run.started_at
            ? { startedOn: new Date(run.started_at).toISOString() }
            : {}),
        },
      },
    },
  };
}
