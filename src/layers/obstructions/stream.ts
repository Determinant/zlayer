import { InvalidDataError } from '../../core/data/errors';

/** WebKit can read a Blob in multi-megabyte chunks and inflate each into one
 * much larger allocation. Bound the compressed input before decompression. */
export function decompressObstructions(blob: Blob): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<BufferSource>({
    async pull(controller) {
      if (offset === blob.size) { controller.close(); return; }
      const end = Math.min(blob.size, offset + 64 * 1024);
      const bytes = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
      offset = end;
      controller.enqueue(bytes);
    },
  }).pipeThrough(new DecompressionStream('gzip'));
}

/** Read the publisher's FeatureCollection incrementally. The national JSON is
 * hundreds of MB; retain at most a chunk and one feature, never the document. */
export async function readObstructionFeatures(stream: ReadableStream<Uint8Array>, expectedBytes: number,
  accept: (feature: unknown) => void): Promise<void> {
  const reader = stream.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, buffer = '', position = 0, start = -1, depth = 0;
  let header = false, done = false, quoted = false, escaped = false, separator = false, afterComma = false;
  const invalid = () => new InvalidDataError('Invalid obstruction FeatureCollection');
  try {
    for (;;) {
      const chunk = await reader.read();
      bytes += chunk.value?.byteLength ?? 0;
      if (bytes > expectedBytes) throw new InvalidDataError('Obstructions exceed the published size');
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      if (!header) {
        const end = buffer.indexOf('[');
        if (end < 0) { if (buffer.length > 4096 || chunk.done) throw invalid(); continue; }
        if (!/^\s*\{\s*"type"\s*:\s*"FeatureCollection"\s*,\s*"features"\s*:\s*$/.test(buffer.slice(0, end))) throw invalid();
        buffer = buffer.slice(end + 1); header = true;
      }
      while (position < buffer.length && !done) {
        const char = buffer[position]!;
        if (start < 0) {
          if (/\s/.test(char)) { position++; continue; }
          if (char === ']' && !afterComma) { done = true; position++; break; }
          if (separator) {
            if (char !== ',') throw invalid();
            separator = false; afterComma = true; position++; continue;
          }
          if (char !== '{') throw invalid();
          start = position; depth = 0; quoted = false; escaped = false; afterComma = false;
        }
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if (char === '{') depth++;
        else if (char === '}') depth--;
        position++;
        if (position - start > 65536) throw invalid();
        if (depth === 0) {
          let feature: unknown;
          try { feature = JSON.parse(buffer.slice(start, position)); }
          catch (cause) { throw new InvalidDataError('Invalid obstruction record', { cause }); }
          accept(feature); start = -1; separator = true;
        }
      }
      const consumed = start < 0 ? position : start;
      buffer = buffer.slice(consumed); position -= consumed;
      if (start >= 0) start = 0;
      if (done && buffer.length > 4096) throw invalid();
      if (chunk.done) break;
    }
    if (!done || buffer.trim() !== '}' || bytes !== expectedBytes) throw invalid();
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}
