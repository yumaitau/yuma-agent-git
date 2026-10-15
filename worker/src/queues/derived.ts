import type { Env } from '../env';
import { recordQueue } from '../observability/metrics';
import { RowParseError } from '../db/client';
import {
  FAILED_SENTINEL,
  getDerived,
  storeRaw,
  type DerivedMessage,
} from '../core/derived';

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
      message.ack();
    } catch (err) {
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
