import { z } from 'zod';
import type { Env } from '../env';
import { forgeEventSchema } from '../webhooks/events';
import { attemptDelivery, fanOut } from '../webhooks/deliver';

/**
 * `forge-events` consumer (issue #75). An `event` message fans out to one
 * delivery per subscribed hook and attempts each; a `delivery` message is a
 * scheduled retry or a manual redelivery. Only a failed fan-out retries the
 * message: a failed attempt is rescheduled by `attemptDelivery`, and a lost
 * one is picked up by the cron sweep once its lease runs out.
 */
const messageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('event'), event: forgeEventSchema }),
  z.object({ type: z.literal('delivery'), id: z.string() }),
]);

export async function webhooksQueue(batch: MessageBatch, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const parsed = messageSchema.safeParse(message.body);
    if (!parsed.success) {
      console.error('webhooks: malformed queue message, dropped');
      message.ack();
      continue;
    }
    let ids: string[];
    try {
      ids =
        parsed.data.type === 'event'
          ? await fanOut(env, parsed.data.event)
          : [parsed.data.id];
    } catch (err) {
      console.error('webhooks: fan-out failed; retrying', err);
      message.retry({ delaySeconds: 30 });
      continue;
    }
    for (const id of ids) {
      await attemptDelivery(env, id).catch((err: unknown) =>
        console.error('webhooks: attempt failed; the sweep will retry', err),
      );
    }
    message.ack();
  }
}
