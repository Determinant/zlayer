import { TERRAIN_ARCHIVE_MAX_BYTES, type TerrainArchive } from '@zlayer/contracts';
import { InvalidDataError } from '../../core/data/errors';
import type { Tile } from './geometry';

/** ZDEM0002 uses int16 metres (-32768 means missing), converted to feet on read.
 * ZDEM0001: LE uint32 zoom/x/y/count, then four offset/length pairs.
 * Each payload is a gzip stream of 65,536 LE float32 elevations in feet MSL.
 * NaN preserves missing samples. No PNG, canvas or SQLite decoding is needed. */
export async function readTerrainArchive(blob: Blob, archive: TerrainArchive, tile: Tile, signal?: AbortSignal, version: 1 | 2 = 1): Promise<Float32Array> {
  signal?.throwIfAborted();
  const invalid = () => new InvalidDataError('Invalid terrain elevation archive');
  if (blob.size !== archive.byteLength || blob.size > TERRAIN_ARCHIVE_MAX_BYTES || blob.size <= 56) throw invalid();
  const header = new DataView(await blob.slice(0, 56).arrayBuffer());
  signal?.throwIfAborted();
  if (new TextDecoder().decode(new Uint8Array(header.buffer, 0, 8)) !== (version === 2 ? 'ZDEM0002' : 'ZDEM0001') ||
    header.getUint32(8, true) !== archive.zoom || header.getUint32(12, true) !== archive.x ||
    header.getUint32(16, true) !== archive.y || header.getUint32(20, true) !== 4 ||
    tile.z !== archive.zoom || tile.x < archive.x || tile.x > archive.x + 1 ||
    tile.y < archive.y || tile.y > archive.y + 1) throw invalid();
  let end = 56;
  for (let i = 0; i < 4; i++) {
    const offset = header.getUint32(24 + i * 8, true), length = header.getUint32(28 + i * 8, true);
    if (offset !== end || !length || offset + length > blob.size) throw invalid();
    end = offset + length;
  }
  if (end !== blob.size) throw invalid();
  const index = (tile.y - archive.y) * 2 + tile.x - archive.x;
  const offset = header.getUint32(24 + index * 8, true), length = header.getUint32(28 + index * 8, true);
  const reader = blob.slice(offset, offset + length).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const abort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  const bytes = new Uint8Array(256 * 256 * (version === 2 ? 2 : 4));
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      if (size + value.length > bytes.length) throw invalid();
      bytes.set(value, size); size += value.length;
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
  }
  if (size !== bytes.length) throw invalid();
  const data = new DataView(bytes.buffer), values = new Float32Array(256 * 256);
  for (let i = 0; i < values.length; i++) {
    const metres = version === 2 ? data.getInt16(i * 2, true) : undefined;
    const height = metres === undefined ? data.getFloat32(i * 4, true) : metres === -32768 ? NaN : metres / 0.3048;
    if (!Number.isNaN(height) && (!Number.isFinite(height) || height < -12000 / 0.3048 || height > 10000 / 0.3048)) throw invalid();
    values[i] = height;
  }
  return values;
}
