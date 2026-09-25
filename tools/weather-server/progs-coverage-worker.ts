import { parentPort } from 'node:worker_threads';
import { inflateSync } from 'node:zlib';
import { decode } from 'fast-png';
import { progsCoverageImageSize } from '@zlayer/contracts';

parentPort!.once('message', (images: Uint8Array[]) => {
  try {
    for (const bytes of images) {
      const { width, height } = progsCoverageImageSize(bytes);
      // Bound zlib output before the PNG decoder allocates decompressed data.
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), chunks: Uint8Array[] = [];
      for (let offset = 8; offset < bytes.length;) {
        if (offset + 12 > bytes.length) throw new Error('Truncated NDFD PNG chunk');
        const length = view.getUint32(offset), end = offset + length + 12;
        if (end > bytes.length) throw new Error('Truncated NDFD PNG data');
        if (view.getUint32(offset + 4) === 0x49444154) chunks.push(bytes.subarray(offset + 8, end - 4));
        offset = end;
      }
      const scanlineBytes = height * (width * 4 + 1);
      if (inflateSync(Buffer.concat(chunks), { maxOutputLength: scanlineBytes }).length !== scanlineBytes) throw new Error('Incomplete NDFD pixel data');
      const image = decode(bytes, { checkCrc: true });
      if (image.width !== width || image.height !== height || image.data.length !== width * height * 4) throw new Error('Incomplete NDFD image');
    }
    parentPort!.postMessage({ value: true });
  } catch (error) { parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
});
