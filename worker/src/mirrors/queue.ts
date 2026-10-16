import type { Env } from '../env';
import { q } from '../db/client';

/**
 * `mirror-sync` queue messages (issues #36, #73). Kept apart from the sync
 * code so core/refs.ts can ask for push mirror syncs without importing the
 * receive path it is part of.
 */
export interface MirrorMessage {
  mirror_id: string;
}

export async function requestMirrorSync(env: Env, ids: string[]): Promise<void> {
  if (!env.MIRROR_QUEUE || ids.length === 0) return;
  await env.MIRROR_QUEUE.sendBatch(
    ids.map((id) => ({ body: { mirror_id: id } satisfies MirrorMessage })),
  );
}

/** After a ref moves: sync the repo's enabled push mirrors. Never fails the move. */
export async function requestPushMirrors(env: Env, repoId: string): Promise<void> {
  try {
    if (!env.MIRROR_QUEUE) return;
    const rows = await q<{ id: string }>(
      env,
      "SELECT id FROM mirrors WHERE repo_id = ? AND direction = 'push' AND enabled = 1",
      [repoId],
    );
    await requestMirrorSync(
      env,
      rows.map((r) => r.id),
    );
  } catch (err) {
    console.error('mirrors: push sync not queued; the schedule will catch up', err);
  }
}
