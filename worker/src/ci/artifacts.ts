/** R2 multipart accepts streams of unknown total length without buffering an image. */
export async function storeArtifact(
  bucket: R2Bucket,
  key: string,
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<void> {
  const upload = await bucket.createMultipartUpload(key);
  const reader = stream.getReader();
  const parts: R2UploadedPart[] = [];
  const size = 5 * 1024 * 1024;
  let buffer = new Uint8Array(size);
  let used = 0;
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > limit) throw new Error('Artifact exceeds size limit');
      for (let offset = 0; offset < chunk.value.length;) {
        const length = Math.min(size - used, chunk.value.length - offset);
        buffer.set(chunk.value.subarray(offset, offset + length), used);
        used += length;
        offset += length;
        if (used === size) {
          parts.push(await upload.uploadPart(parts.length + 1, buffer));
          buffer = new Uint8Array(size);
          used = 0;
        }
      }
    }
    if (used)
      parts.push(await upload.uploadPart(parts.length + 1, buffer.subarray(0, used)));
    if (!parts.length) throw new Error('Image export is empty');
    await upload.complete(parts);
  } catch (error) {
    await reader.cancel().catch(() => {});
    await upload.abort();
    throw error;
  } finally {
    reader.releaseLock();
  }
}
