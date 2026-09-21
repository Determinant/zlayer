import assert from 'node:assert/strict';
import test from 'node:test';
import { EXPORT_CHUNK_BYTES, recordingBytes, recordingGpx } from '../src/layers/ahrs/recording-export';
import { EXPORT_MEMORY_LIMIT, exportFileSink, removeExportFiles, writeExportFile } from '../src/core/storage/export-file';
import { recordingFilename, type RecordingInfo } from '../src/layers/ahrs/recording-storage';

const origin = Date.UTC(2026, 8, 20, 23, 59, 59);
const info: RecordingInfo = { version: 1, id: 'example-recording', startedAt: origin, updatedAt: origin + 20_000,
  status: 'complete', chunks: 1, events: 10, bytes: 0 };
const header = { format: 'zlayer-ahrs', version: 1, context: { timeOrigin: origin, estimatorModel: 'test-model',
  mount: 'upright', estimatorOptions: { maxTiltStd: 5 }, trim: [1, 0, 0, 0] } };
const gps = (time: number, fix = {}) => ({ state: 'tracking', fix: { timestamp: origin + time * 1000,
  coordinates: [-122.123456, 37.123456], altitude: 1000.5, speed: 50, track: 90, accuracy: 5,
  altitudeAccuracy: 8, estimated: false, ...fix } });
const state = (yaw: number) => ({ phase: 'ready', crossed: false, warning: '', attitude: { roll: 3, pitch: 2, yaw,
  quaternion: [1, 0, 0, 0], headingReference: 'relative', headingStatus: 'acquiring', status: 'tracking',
  attitudeStd: [1, 2, Infinity], tiltStd: 2, age: 0, bias: [.001, 0, 0], accelBias: [0, 0, .1],
  gpsAiding: false, tiltAiding: true, magneticFusion: { active: true } } });

function source(rows: [string, number, unknown][], slice = 71) {
  const bytes = new TextEncoder().encode(rows.map(([type, time, data], sequence) =>
    JSON.stringify({ sequence, type, time, data }, (_, value: unknown) => value === Infinity ? 'Infinity' : value)).join('\n') + '\n');
  return async function* () {
    for (let offset = 0; offset < bytes.length; offset += slice) yield new Blob([bytes.slice(offset, offset + slice)]);
  };
}
async function text(stream: AsyncIterable<Uint8Array<ArrayBuffer>>) {
  const parts = [];
  for await (const bytes of stream) { assert.ok(bytes.length <= EXPORT_CHUNK_BYTES); parts.push(bytes); }
  return new Blob(parts).text();
}

test('GPX keeps acquisition times, unique fixes, GPS course and independently timed AHRS states', async () => {
  const xml = await text(recordingGpx(source([
    ['header', 0, header], ['gps', .5, gps(0)], ['state', .6, state(120)], ['state', .7, state(121)],
    ['gps', .9, gps(0)], ['gps', 1.5, gps(1, { altitude: null, altitudeAccuracy: null })],
    ['state', 1.6, state(122)], ['end', 2, {}],
  ]), info));
  assert.equal((xml.match(/<trkpt /g) ?? []).length, 2);
  assert.equal((xml.match(/<z:state /g) ?? []).length, 3);
  assert.equal((xml.match(/<ele>/g) ?? []).length, 1);
  assert.ok(xml.includes('<time>2026-09-21T00:00:00.000Z</time>'));
  assert.ok(xml.includes('receivedTime="2026-09-21T00:00:00.500Z"'));
  assert.ok(xml.includes('time="2026-09-20T23:59:59.600Z" t="0.6"'));
  assert.ok(xml.includes('course="90"') && xml.includes('yaw="120"'));
  assert.ok(xml.includes('headingReference="relative" headingStatus="acquiring"'));
  assert.ok(!xml.includes('headingStd=') && !xml.includes('Infinity'));
  assert.ok(xml.includes('complete="true"'));
  assert.match(xml, /<\/z:recording><\/extensions>\n<\/gpx>\n$/);
});

test('gaps, invalid coordinates and stale notifications do not fabricate a continuous GPS path', async () => {
  const xml = await text(recordingGpx(source([
    ['header', 0, header], ['gps', 0, gps(0)], ['gps', 1, gps(1, { coordinates: [300, 37] })],
    ['gps', 2, { ...gps(0), state: 'stale' }], ['gps', 3, gps(3)], ['gps', 20, gps(20)],
    ['gps', 21, gps(21, { coordinates: [180, 0.00000001] })],
  ]), info));
  assert.equal((xml.match(/<trkseg>/g) ?? []).length, 3);
  assert.equal((xml.match(/<trkpt /g) ?? []).length, 4);
  assert.ok(xml.includes('lat="0.00000001" lon="-180"'));
  assert.ok(xml.includes('complete="false"'));
});

test('GPX escapes calibration/issue metadata, preserving Unicode across storage boundaries', async () => {
  const xml = await text(recordingGpx(source([
    ['header', 0, header], ['calibrate', 0, { mount: 'flat', trueHeading: 0 }], ['gps', 0, gps(0)],
    ['issue', 1, { message: 'München 🛩 <test> & "quoted"' }],
  ], 1), info));
  assert.ok(xml.includes(String.raw`München 🛩 &lt;test&gt; &amp; \&quot;quoted\&quot;`));
  assert.ok(xml.includes('type="calibrate"'));
  assert.ok(xml.includes('&quot;trueHeading&quot;:0'));
});

test('empty/no-GPS, malformed and incomplete event sequences fail clearly', async () => {
  await assert.rejects(text(recordingGpx(source([['header', 0, header]]), info)), /No GPS positions/);
  const bad = async function* () {
    yield new Blob([JSON.stringify({ sequence: 0, type: 'header', time: 0, data: header }) + '\n' +
      JSON.stringify({ sequence: 2, type: 'gps', time: 1, data: gps(1) }) + '\n']);
  };
  await assert.rejects(text(recordingGpx(bad, info)), /missing entries/);
  await assert.rejects(text(recordingGpx(source([['header', 0, { ...header, version: 2 }]]), info)), /Unsupported/);
  await assert.rejects(text(recordingGpx(source([['header', 0, { ...header, context: {} }]]), info)), /time origin/);
});

test('large input is consumed lazily and output pieces remain bounded', async () => {
  let read = 0;
  const source = async function* () {
    yield new Blob([JSON.stringify({ sequence: 0, type: 'header', time: 0, data: header }) + '\n']);
    for (let i = 1; i <= 100_000; i++) {
      read++;
      yield new Blob([JSON.stringify({ sequence: i, type: 'gps', time: i, data: gps(i) }) + '\n']);
    }
  };
  const stream = recordingGpx(source, info);
  const first = await stream.next();
  assert.equal(first.done, false);
  assert.ok(first.value!.length <= EXPORT_CHUNK_BYTES);
  assert.ok(read > 1 && read < 100, `read only ${read} records before yielding`);
  await stream.return(undefined);
  const data = new Uint8Array(EXPORT_CHUNK_BYTES * 4 + 5).fill(42);
  const bytes = recordingBytes((async function* () { yield new Blob([data]); })());
  let count = 0, total = 0;
  for await (const chunk of bytes) { count++; total += chunk.length; assert.ok(chunk.length <= EXPORT_CHUNK_BYTES); }
  assert.equal(count, 5); assert.equal(total, data.length);
});

test('an oversized corrupt line is rejected without reading the remaining recording', async () => {
  let reads = 0;
  const source = async function* () {
    for (let i = 0; i < 100; i++) { reads++; yield new Blob(['x'.repeat(64 * 1024)]); }
  };
  await assert.rejects(text(recordingGpx(source, info)), /too large/);
  assert.ok(reads < 20);
});

test('browsers without disk export have a strict fallback size limit', async () => {
  const storage = { getDirectory: async () => { throw new DOMException('Unavailable', 'NotSupportedError'); } };
  const sink = await exportFileSink('example.jsonl', 'application/x-ndjson', storage);
  const chunk = new Uint8Array(EXPORT_CHUNK_BYTES).fill(65);
  for (let i = 0; i < EXPORT_MEMORY_LIMIT / chunk.length; i++) sink.write(chunk);
  assert.throws(() => sink.write(new Uint8Array(1)), /8 MiB memory limit/);
  await sink.abort();
  const small = await exportFileSink('small.jsonl', 'application/x-ndjson', storage);
  small.write(new TextEncoder().encode('recording\n'));
  const file = await small.finish();
  assert.equal(file.size, 10); assert.equal(file.type, 'application/x-ndjson');
});

test('disk export handles short writes at successive offsets and closes before reading the file', async () => {
  let closed = false, flushed = false;
  const written: number[] = [], removed: string[] = [];
  const file = {
    async createSyncAccessHandle() {
      return { truncate() {}, write(bytes: Uint8Array, { at }: { at: number }) {
        assert.equal(at, written.length); const count = Math.min(3, bytes.length);
        written.push(...bytes.subarray(0, count)); return count;
      }, flush() { flushed = true; }, close() { closed = true; } };
    },
    async getFile() { assert.ok(closed && flushed); return new Blob([new Uint8Array(written)]); },
  };
  const directory = { async *entries() {}, async getFileHandle() { return file; },
    async removeEntry(name: string) { removed.push(name); } };
  const storage = { async getDirectory() { return { async getDirectoryHandle() { return directory; } }; } } as unknown as StorageManager;
  const sink = await exportFileSink('example.gpx', 'application/gpx+xml', storage);
  sink.write(new TextEncoder().encode('first\n')); sink.write(new TextEncoder().encode('second\n'));
  const output = await sink.finish();
  assert.equal(await output.text(), 'first\nsecond\n');
  assert.equal(output.type, 'application/gpx+xml');
  assert.deepEqual(removed, []);
  await sink.abort(); assert.deepEqual(removed, ['example.gpx']);
});

test('unavailable OPFS and exhausted quota use the same bounded fallback', async () => {
  for (const name of ['UnknownError', 'SecurityError', 'NotSupportedError', 'QuotaExceededError']) {
    const storage = { getDirectory: async () => { throw new DOMException('Unavailable', name); } };
    const result = await writeExportFile('example.jsonl', 'application/x-ndjson', async function* () {
      yield new TextEncoder().encode('saved data\n');
    }, storage);
    assert.equal(result.inMemory, true);
    assert.equal(await result.blob.text(), 'saved data\n');
  }
  const storage = { getDirectory: async () => { throw new DOMException('Storage full', 'QuotaExceededError'); } };
  let reads = 0;
  await assert.rejects(writeExportFile('large.jsonl', 'application/x-ndjson', async function* () {
    for (let i = 0; i < 1000; i++) { reads++; yield new Uint8Array(EXPORT_CHUNK_BYTES); }
  }, storage), /8 MiB memory limit/);
  assert.equal(reads, EXPORT_MEMORY_LIMIT / EXPORT_CHUNK_BYTES + 1);
  assert.match(recordingFilename(info, 'gpx'), /\.gpx$/);
  assert.match(recordingFilename(info, 'jsonl'), /\.jsonl$/);
});

for (const stage of ['write', 'flush'] as const) {
  test(`quota failure during ${stage} closes the partial file and restarts the complete output within the memory cap`, async () => {
    let closed = false, removed = false, passes = 0, writes = 0;
    const file = {
      async createSyncAccessHandle() { return {
        truncate() {},
        write(bytes: Uint8Array) {
          if (stage === 'write' && writes++ === 1) throw new DOMException('Storage full', 'QuotaExceededError');
          return bytes.length;
        },
        flush() { throw new DOMException('Storage full', 'QuotaExceededError'); },
        close() { closed = true; },
      }; },
      async getFile() { throw new Error('Must not return a partial disk file'); },
    };
    const directory = { async *entries() {}, async getFileHandle() { return file; },
      async removeEntry() { assert.ok(closed); removed = true; } };
    const storage = { async getDirectory() { return { async getDirectoryHandle() { return directory; } }; } } as unknown as StorageManager;
    const result = await writeExportFile('example.gpx', 'application/gpx+xml', async function* () {
      passes++;
      if (passes === 2) assert.ok(closed && removed);
      yield new TextEncoder().encode('first\n');
      yield new TextEncoder().encode('second\n');
    }, storage);
    assert.equal(passes, 2);
    assert.equal(result.inMemory, true);
    assert.equal(await result.blob.text(), 'first\nsecond\n');
  });
}

test('reset skips an unavailable OPFS root but still surfaces an actual file deletion failure', async () => {
  for (const name of ['UnknownError', 'SecurityError', 'NotSupportedError']) {
    await removeExportFiles(undefined, { getDirectory: async () => { throw new DOMException('Unavailable', name); } });
  }
  const storage = { async getDirectory() { return {
    async removeEntry() { throw new DOMException('Deletion failed', 'UnknownError'); },
  }; } } as unknown as StorageManager;
  await assert.rejects(removeExportFiles(undefined, storage), /Deletion failed/);
});
