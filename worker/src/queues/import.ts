import type { Env } from '../env';
import { markJobFailed, runImportMessage } from '../bridge/import';
import { runExportJob, type GitImportMessage } from '../bridge/exportPush';

/**
 * `git-import` queue consumer (issue #15): one import at a time (imports are
 * heavy). Transient failures retry the batch; after 3 attempts the job is
 * marked failed and the message acked — a poison import must not loop.
 */
export async function importQueue(
  batch: MessageBatch<GitImportMessage>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages.slice(0, 1)) {
    try {
      if (message.body.type === 'export_job') {
        await runExportJob(env, message.body.job_id);
      } else {
        await runImportMessage(env, message.body);
      }
      message.ack();
    } catch (err) {
      if (message.attempts >= 3) {
        const jobId =
          message.body.type === 'import_job' || message.body.type === 'export_job'
            ? message.body.job_id
            : null;
        if (jobId && message.body.type === 'import_job')
          await markJobFailed(env, jobId, err);
        console.error(
          'git-import: giving up',
          JSON.stringify({ attempts: message.attempts }),
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
