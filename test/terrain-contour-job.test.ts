import assert from 'node:assert/strict';
import test from 'node:test';
import { TerrainContourJob } from '../src/layers/terrain/contour-job';
import type { TerrainIsoline } from '../src/layers/terrain/isolines';
import type { TerrainVectors } from '../src/layers/terrain/vector-cache';

const vectors = (elevation: number): TerrainVectors[] => [{ labels: [], lines: [{ elevation, opacity: 1, coordinates: [[[0, 0], [1, 1]]] }] }];
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test('terrain contour preparation admits one job and only the latest pending snapshot', async () => {
  const calls: { lines: TerrainIsoline[]; signal: AbortSignal; resolve: (lines: TerrainIsoline[]) => void }[] = [];
  const job = new TerrainContourJob(() => {}, (lines, _borders, _segments, signal) => new Promise(resolve => calls.push({ lines, signal, resolve })));
  const published: number[] = [], publish = (lines: TerrainIsoline[]) => published.push(lines[0]!.elevation);
  job.request(vectors(1), [], publish);
  job.request(vectors(2), [], publish);
  job.request(vectors(3), [], publish);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.signal.aborted, true);
  assert.equal(job.pending, true);
  calls[0]!.resolve(calls[0]!.lines); await settle();
  assert.deepEqual(published, [], 'superseded completion never publishes');
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.lines[0]!.elevation, 3);
  calls[1]!.resolve(calls[1]!.lines); await settle();
  assert.deepEqual(published, [3]);
  assert.equal(job.pending, false);
});

test('route/source reset or unmount drops active and queued contour publications', async () => {
  let resolve!: (lines: TerrainIsoline[]) => void, calls = 0, published = 0, changed = 0;
  const job = new TerrainContourJob(() => changed++, () => { calls++; return new Promise(done => { resolve = done; }); });
  job.request(vectors(1), [], () => published++);
  job.request(vectors(2), [], () => published++);
  job.clear(); resolve([]); await settle();
  assert.equal(published, 0); assert.equal(calls, 1); assert.equal(job.pending, false); assert.equal(job.failed, false);
  assert.equal(changed, 0, 'teardown suppresses late status callbacks too');
});

test('contour preparation failure settles without polling and new demand can recover', async () => {
  let calls = 0, published = 0;
  const job = new TerrainContourJob(() => {}, async lines => { if (++calls === 1) throw new Error('failed'); return lines; });
  job.request(vectors(1), [], () => published++); await settle();
  assert.equal(job.failed, true); assert.equal(job.pending, false); assert.equal(calls, 1);
  job.request(vectors(2), [], () => published++); await settle();
  assert.equal(job.failed, false); assert.equal(job.pending, false); assert.equal(published, 1);
});
