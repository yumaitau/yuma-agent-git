import type { Env } from '../env';
import { recordQueue } from '../observability/metrics';
import { RowParseError } from '../db/client';
import {
  DerivedDeferredError,
  FAILED_SENTINEL,
  continuation,
  enqueueDerived,
  getDerived,
  storeRaw,
  type DerivedMessage,
} from '../core/derived';
import {
  isSecretScanMessage,
  secretScanMessage,
  type SecretScanMessage,
} from '../security/secrets/history';

/**
 * `derived-data` queue consumer (architecture §1.5): computes deferred kinds
 * in the background — the path blame/path-history routes take when the caller
 * opts into `?background=1`, and the oversize-payload compaction channel.
 *
 * Retries: transient failures retry the batch; permanent failures and poison
 * messages (3+ attempts) are acked with a `{failed:true}` sentinel row so
 * readers see a terminal answer instead of recomputing forever.
 */
export async function derivedQueue(
  batch: MessageBatch<DerivedMessage>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages.slice(0, 10)) {
    await recordQueue(env);
    // secret scanning history scans (#66) share this queue
    if (isSecretScanMessage(message.body)) {
      await secretScanMessage(env, message as unknown as Message<SecretScanMessage>);
      continue;
    }
    const { repo_id: repoId, kind, cs_id: csId, compaction } = message.body;
    try {
      if (compaction) {
        // Kind-specific compaction hooks land with the oversize-prone kinds
        // (blame chunking, issue #10). The sentinel row is already stored.
        message.ack();
        continue;
      }
      const value = await getDerived(env, repoId, kind, csId);
      if (value === null) {
        // Target changeset not visible yet (or gone): transient until the
        // attempt budget runs out, then terminal like any poison message.
        throw new MissingTargetError(`${kind}:${csId}`);
      }
      const [next, ...rest] = message.body.resume ?? [];
      if (next !== undefined) {
        await enqueueDerived(env, [
          {
            repo_id: repoId,
            kind,
            cs_id: next,
            ...(rest.length > 0 ? { resume: rest } : {}),
          },
        ]);
      }
      message.ack();
    } catch (err) {
      if (err instanceof DerivedDeferredError) {
        // progress is stored; continue in a fresh invocation (not a failure)
        await enqueueDerived(env, [continuation(message.body, err)]);
        message.ack();
        continue;
      }
      const permanent = isPermanent(err);
      if (permanent || message.attempts >= 3) {
        await storeRaw(env, repoId, kind, csId, FAILED_SENTINEL);
        console.error(
          'derived-data: giving up',
          JSON.stringify({
            repo_id: repoId,
            kind,
            cs_id: csId,
            attempts: message.attempts,
          }),
          err,
        );
        message.ack();
      } else {
        batch.retryAll();
        return;
      }
    }
  }
}

class MissingTargetError extends Error {
  constructor(target: string) {
    super(`derived target missing: ${target}`);
    this.name = 'MissingTargetError';
  }
}

function isPermanent(err: unknown): boolean {
  if (err instanceof RowParseError) return true;
  return err instanceof Error && err.message.startsWith('unknown derived kind');
}
