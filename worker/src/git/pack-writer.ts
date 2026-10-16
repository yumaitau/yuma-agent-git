import { concatBytes } from './pktline';
import type { GitObjectType } from './objects';

/**
 * Streaming packfile writer (issue #31): version 2, undeltified objects, each
 * compressed with `CompressionStream('deflate')` (zlib, as packs require),
 * then the SHA-1 of everything before it. Objects come from an async
 * iterable one at a time, so memory holds one object, never the pack.
 */

export interface PackObject {
  type: GitObjectType;
  body: Uint8Array;
}

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3 };

/** Type and inflated size: 3 type bits and 4 size bits, then 7 bits a byte. */
export function objectHeader(typeCode: number, size: number): Uint8Array {
  const out: number[] = [];
  let byte = (typeCode << 4) | (size & 15);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    out.push(byte | 0x80);
    byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  out.push(byte);
  return new Uint8Array(out);
}

export async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const stream = source.pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function packHeader(count: number): Uint8Array {
  const out = new Uint8Array(12);
  out.set(new TextEncoder().encode('PACK'));
  const view = new DataView(out.buffer);
  view.setUint32(4, 2);
  view.setUint32(8, count);
  return out;
}

/** Pack bytes in order: header, one chunk per object, then the trailer. */
export async function* packChunks(
  count: number,
  objects: AsyncIterable<PackObject>,
): AsyncGenerator<Uint8Array> {
  const digest = new crypto.DigestStream('SHA-1');
  const hasher = digest.getWriter();
  const header = packHeader(count);
  await hasher.write(header);
  yield header;
  let written = 0;
  for await (const object of objects) {
    const chunk = concatBytes([
      objectHeader(TYPE_CODE[object.type], object.body.length),
      await deflate(object.body),
    ]);
    await hasher.write(chunk);
    yield chunk;
    written++;
  }
  if (written !== count) {
    throw new Error(`pack declared ${count} objects but wrote ${written}`);
  }
  await hasher.close();
  yield new Uint8Array(await digest.digest);
}

/** A ReadableStream over an async generator, pulled on demand. */
export function streamOf(chunks: AsyncGenerator<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await chunks.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
}
