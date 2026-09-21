/** WebKit may read Blob.stream() in multi-megabyte chunks. Bound input before
 * decompression so a single pull cannot inflate a large fraction of a dataset. */
export function boundedBlobStream(blob: Blob): ReadableStream<Uint8Array<ArrayBuffer>> {
  let offset = 0;
  return new ReadableStream({
    async pull(controller) {
      if (offset === blob.size) { controller.close(); return; }
      const end = Math.min(blob.size, offset + 64 * 1024);
      const bytes = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
      offset = end;
      controller.enqueue(bytes);
    },
  });
}
