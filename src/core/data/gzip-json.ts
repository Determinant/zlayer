import { boundedBlobStream } from '../storage/blob-stream';
import { InvalidDataError } from './errors';

export type GzipJsonSize = { bytes: number; uncompressedBytes: number };

/** Keep the original compressed response in Cache Storage; bound decompression by the manifest. */
export async function parseGzipJson(response: Response, expected: GzipJsonSize): Promise<unknown> {
  if (!response.body) throw new InvalidDataError('Missing gzip response body');
  const blob = await new Response(response.body.pipeThrough(limitBytes(Math.max(expected.bytes, expected.uncompressedBytes))))
    .blob();
  const bytes = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    if (blob.size !== expected.bytes) throw new InvalidDataError('Compressed route history size does not match the manifest');
    const decoded = boundedBlobStream(blob).pipeThrough(new DecompressionStream('gzip'))
      .pipeThrough(limitBytes(expected.uncompressedBytes, true));
    try { return JSON.parse(await new Response(decoded).text()) as unknown; }
    catch (cause) {
      if (cause instanceof InvalidDataError) throw cause;
      if (cause instanceof SyntaxError || cause instanceof TypeError ||
        (cause instanceof DOMException && cause.name === 'DataError')) {
        throw new InvalidDataError('Invalid gzip route history', { cause });
      }
      throw cause;
    }
  }
  // Fetch may already have decoded Content-Encoding: gzip, even when CORS hides that header.
  if (blob.size === expected.uncompressedBytes) {
    try { return JSON.parse(await blob.text()) as unknown; }
    catch (cause) {
      if (cause instanceof SyntaxError) throw new InvalidDataError('Invalid gzip route history', { cause });
      throw cause;
    }
  }
  throw new InvalidDataError('Invalid gzip route history');
}

function limitBytes(limit: number, exact = false) {
  let received = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > limit) throw new InvalidDataError('Route history exceeds its published size');
      controller.enqueue(chunk);
    },
    flush() { if (exact && received !== limit) throw new InvalidDataError('Route history size does not match the manifest'); },
  });
}
