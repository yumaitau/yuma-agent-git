import type { Env } from '../env';
import type { RepoRecord } from '../db/client';
import { listRefs } from '../db/repos';
import { AGENT_PREFIX } from '../core/refs';
import { GitProtocolError, PktLineError, PktReader, pktText } from './pktline';
import { commitShas, fetchPack, gitRefName } from './upload-pack';

/**
 * A Git bundle (v2) of every branch and tag (issue #70): `git clone
 * repo.bundle` restores the repository with the same commit SHAs. The pack is
 * the one a full `git clone` would fetch, taken out of its sideband framing.
 * Agent work refs stay out, as they do for clones.
 */
export async function bundleStream(
  env: Env,
  repo: RepoRecord,
): Promise<ReadableStream<Uint8Array> | null> {
  const refs = (await listRefs(env, repo.id)).filter(
    (r) => !r.name.startsWith(AGENT_PREFIX),
  );
  if (refs.length === 0) return null;
  const shas = await commitShas(
    env,
    repo.id,
    refs.map((r) => r.head),
  );
  const lines = ['# v2 git bundle'];
  const head = refs.find((r) => r.name === repo.default_branch);
  if (head) lines.push(`${shas.get(head.head)} HEAD`);
  for (const r of refs) lines.push(`${shas.get(r.head)} ${gitRefName(r.name)}`);
  const wants = [...new Set(shas.values())].map((sha) => `want ${sha}`);
  const response = await fetchPack(env, repo.id, [...wants, 'no-progress', 'done']);
  const header = new TextEncoder().encode(`${lines.join('\n')}\n\n`);
  return response.pipeThrough(packOnly()).pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      start(controller) {
        controller.enqueue(header);
      },
    }),
  );
}

/** The pack bytes of a v2 fetch response: band 1 after `packfile`. */
function packOnly(): TransformStream<Uint8Array, Uint8Array> {
  let buffer = new Uint8Array(0);
  let inPack = false;
  return new TransformStream({
    transform(chunk, controller) {
      const joined = new Uint8Array(buffer.length + chunk.length);
      joined.set(buffer);
      joined.set(chunk, buffer.length);
      const reader = new PktReader(joined);
      let consumed = 0;
      for (;;) {
        let pkt;
        try {
          pkt = reader.next();
        } catch (err) {
          if (err instanceof PktLineError && /truncated/.test(err.message)) break;
          throw err;
        }
        if (pkt === null) break;
        consumed = reader.offset;
        if (pkt.kind !== 'data') continue;
        if (!inPack) {
          if (pktText(pkt.data) === 'packfile') inPack = true;
          continue;
        }
        const band = pkt.data[0];
        if (band === 1) controller.enqueue(pkt.data.slice(1));
        else if (band === 3)
          throw new GitProtocolError(new TextDecoder().decode(pkt.data.subarray(1)));
      }
      buffer = joined.slice(consumed);
    },
  });
}
