import type { Env } from '../env';
import { forgeEventSchema } from '../webhooks/events';
import { notifyEvent } from '../notify/fanout';

/**
 * `notifications` consumer (issue #44): each message is a domain event from
 * `emitEvent`. Fan-out is idempotent per event and recipient, so a failed
 * message (storage or email provider) is simply retried.
 */
export async function notifyQueue(batch: MessageBatch, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const parsed = forgeEventSchema.safeParse(message.body);
    if (!parsed.success) {
      console.error('notifications: malformed queue message, dropped');
      message.ack();
      continue;
    }
    try {
      await notifyEvent(env, parsed.data);
      message.ack();
    } catch (err) {
      console.error('notifications: fan-out failed; retrying', err);
      message.retry({ delaySeconds: 60 });
    }
  }
}
