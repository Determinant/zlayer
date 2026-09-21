import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { readTerrainArchive } from '../src/layers/terrain/archive';

function fixture(bytes = new Uint8Array(256 * 256 * 4)) {
  const payload = gzipSync(bytes), header = new Uint8Array(56), view = new DataView(header.buffer);
  header.set(new TextEncoder().encode('ZDEM0001'));
  view.setUint32(8, 1, true); view.setUint32(20, 4, true);
  for (let i = 0; i < 4; i++) {
    view.setUint32(24 + i * 8, 56 + i * payload.length, true);
    view.setUint32(28 + i * 8, payload.length, true);
  }
  const blob = new Blob([header, payload, payload, payload, payload]);
  const archive = { zoom: 1, x: 0, y: 0, file: 'fixture.dem', sha256: '', byteLength: blob.size };
  return { blob, archive, tile: { z: 1, x: 0, y: 0 } };
}

test('packaged DEM inflation rejects short/oversized grids and invalid heights', async () => {
  for (const size of [256 * 256 * 4 - 4, 256 * 256 * 4 + 4]) {
    const { blob, archive, tile } = fixture(new Uint8Array(size));
    await assert.rejects(readTerrainArchive(blob, archive, tile), /Invalid terrain elevation archive/);
  }
  for (const height of [Infinity, -Infinity, -40000, 40000]) {
    const bytes = new Uint8Array(256 * 256 * 4);
    new DataView(bytes.buffer).setFloat32(0, height, true);
    const { blob, archive, tile } = fixture(bytes);
    await assert.rejects(readTerrainArchive(blob, archive, tile), /Invalid terrain elevation archive/);
  }
});

test('canceling a packaged DEM stops the active decompression stream', { timeout: 3000 }, async t => {
  const { blob, archive, tile } = fixture();
  let onStart!: () => void, onStop!: () => void;
  const started = new Promise<void>(resolve => { onStart = resolve; });
  const stopped = new Promise<void>(resolve => { onStop = resolve; });
  const slice = blob.slice.bind(blob);
  t.mock.method(blob, 'slice', (start?: number, end?: number) => {
    const part = slice(start, end);
    if (start !== 0) t.mock.method(part, 'stream', () => new ReadableStream<Uint8Array>({
      pull() { onStart(); }, cancel() { onStop(); },
    }));
    return part;
  });
  const controller = new AbortController();
  const canceled = assert.rejects(readTerrainArchive(blob, archive, tile, controller.signal), { name: 'AbortError' });
  await started;
  controller.abort();
  await canceled;
  await stopped;
  await assert.rejects(readTerrainArchive(blob, archive, tile, controller.signal), { name: 'AbortError' });
});
