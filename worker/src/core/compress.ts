/**
 * Object compression codecs, all via the native Compression Streams API —
 * no dependencies.
 *
 * `zstd` is the intended codec (architecture §1.1). The Cloudflare Workers
 * runtime currently supports only `deflate` / `deflate-raw` / `gzip` in
 * `CompressionStream`, so we feature-detect: prefer `zstd` when the runtime
 * (or a future compatibility date) offers it, else fall back to `deflate-raw`.
 * The codec actually used is recorded per object in R2 `customMetadata`, and
 * content addresses are always SHA-256 of the **uncompressed** bytes, so the
 * choice is invisible to clients and can change retroactively.
 */
export type Codec = 'zstd' | 'deflate-raw';

type ByteTransform = ReadableWritablePair<Uint8Array, ArrayBuffer | ArrayBufferView>;

// The runtime's constructor only advertises today's codecs; probe with any
// string at runtime and accept future formats (zstd) without a redeploy.
const CompressionCtor = CompressionStream as unknown as {
  new (format: string): ByteTransform;
};
const DecompressionCtor = DecompressionStream as unknown as {
  new (format: string): ByteTransform;
};

function codecSupported(codec: string): boolean {
  try {
    new CompressionCtor(codec);
    new DecompressionCtor(codec);
    return true;
  } catch {
    return false;
  }
}

let preferred: Codec | null = null;

/** The codec used for newly written objects. */
export function preferredCodec(): Codec {
  if (preferred === null) {
    preferred = codecSupported('zstd') ? 'zstd' : 'deflate-raw';
  }
  return preferred;
}

/**
 * Parse a stored `encoding` value. Fails closed on missing/unknown codecs:
 * the codec is not covered by the content hash, so guessing wrong would
 * corrupt reads. Every write path sets it.
 */
export function parseCodec(encoding: string | undefined): Codec {
  if (encoding !== 'zstd' && encoding !== 'deflate-raw') {
    throw new TypeError(`unknown object encoding: ${encoding ?? '(missing)'}`);
  }
  return encoding;
}

function sourceStream(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
}

async function pump(data: Uint8Array, transform: ByteTransform): Promise<Uint8Array> {
  const out = sourceStream(data).pipeThrough(transform);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

/** Compress raw bytes with the given codec. */
export function compressBytes(data: Uint8Array, codec: Codec): Promise<Uint8Array> {
  return pump(data, new CompressionCtor(codec));
}

/** Decompress stored bytes with the given codec. */
export function decompressBytes(data: Uint8Array, codec: Codec): Promise<Uint8Array> {
  return pump(data, new DecompressionCtor(codec));
}

/** A streaming decompressor for large raw reads (no full buffering). */
export function decompressStream(codec: Codec): ByteTransform {
  return new DecompressionCtor(codec);
}
