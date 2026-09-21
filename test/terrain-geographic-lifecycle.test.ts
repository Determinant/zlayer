import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { setImmediate as tick } from 'node:timers/promises';
import test from 'node:test';
import { terrainSpacing } from '@zlayer/contracts';
import { project, type Tile } from '../src/layers/terrain/geometry';
import type { TerrainPackage, readPackagedElevation } from '../src/layers/terrain/packages';

// Control the archive-read boundary while exercising the real geographic
// resampler, shared-read lifecycle, concurrency limit and completed-grid cache.
const loader = registerHooks({ resolve(specifier, context, next) {
  if (specifier === './packages' && context.parentURL?.endsWith('/terrain/geographic.ts')) return {
    shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(
      'export const readPackagedElevation = (...args) => globalThis.readTestGeographicGrid(...args);'),
  };
  return next(specifier, context);
} });
const { geographicTiles, readGeographicElevation } = await import('../src/layers/terrain/geographic');
loader.deregister();

const point = project([-180 + 166.5 * 256 * terrainSpacing(10), 90 - 152.5 * 256 * terrainSpacing(10)]);
const tile: Tile = { z: 13, x: Math.floor(point[0] * 8192), y: Math.floor(point[1] * 8192) };
assert.deepEqual(geographicTiles(tile), [{ z: 10, x: 166, y: 152 }], 'fixture needs exactly one geographic grid');

type GridRead = { signal: AbortSignal; deferAbort: boolean; finish: (height?: number) => void; fail: (error: Error) => void };
function fixture(t: test.TestContext) {
  const jobs: GridRead[] = [], controllers: AbortController[] = [], requests: Promise<Float32Array>[] = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, 'readTestGeographicGrid');
  const readGrid: typeof readPackagedElevation = (_tile, _source, signal, version) => {
    assert.equal(version, 2);
    signal.throwIfAborted();
    let job!: GridRead, abort!: () => void;
    const promise = new Promise<Float32Array>((resolve, reject) => {
      job = { signal, deferAbort: false, finish: (height = 1200) => resolve(new Float32Array(256 * 256).fill(height)), fail: reject };
      abort = () => { if (!job.deferAbort) reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
      jobs.push(job);
    });
    return promise.finally(() => signal.removeEventListener('abort', abort));
  };
  Object.defineProperty(globalThis, 'readTestGeographicGrid', { configurable: true, value: readGrid });
  const source = (id: number): TerrainPackage => ({ root: `https://terrain.test/${encodeURIComponent(t.name)}/${id}`,
    grid: 'EPSG:4326', shard: { zoom: 10, x: 128, y: 128, file: `${'a'.repeat(64)}.terrain`, sha256: 'a'.repeat(64), byteLength: 100 } });
  const read = (id: number, controller = new AbortController()) => {
    controllers.push(controller);
    const request = readGeographicElevation(tile, [source(id)], controller.signal);
    requests.push(request);
    return request;
  };
  t.after(async () => {
    controllers.forEach(controller => controller.abort());
    jobs.forEach(job => job.finish());
    await Promise.allSettled(requests);
    if (original) Object.defineProperty(globalThis, 'readTestGeographicGrid', original);
    else Reflect.deleteProperty(globalThis, 'readTestGeographicGrid');
  });
  return { jobs, read };
}

test('canceling one geographic reader preserves its peer and the completed cache', async t => {
  const { jobs, read } = fixture(t), controller = new AbortController();
  const canceled = assert.rejects(read(0, controller), { name: 'AbortError' });
  const remaining = read(0);
  assert.equal(jobs.length, 1, 'both Mercator reads share one native decode');
  controller.abort(); await canceled;
  assert.equal(jobs[0]!.signal.aborted, false);
  jobs[0]!.finish();
  const values = await remaining;
  assert.ok(values.every(value => value === 1200));
  assert.deepEqual(await read(0), values);
  assert.equal(jobs.length, 1, 'completed geographic grids remain reusable');
});

test('the last geographic reader cancels the underlying work and late completion cannot replace its retry', async t => {
  const { jobs, read } = fixture(t), a = new AbortController(), b = new AbortController();
  const first = assert.rejects(read(0, a), { name: 'AbortError' });
  const second = assert.rejects(read(0, b), { name: 'AbortError' });
  jobs[0]!.deferAbort = true; // Model a read whose cancellation takes time to settle.
  a.abort(); await first;
  assert.equal(jobs[0]!.signal.aborted, false);
  b.abort(); await second;
  assert.equal(jobs[0]!.signal.aborted, true);
  const retry = read(0);
  assert.equal(jobs.length, 2);
  jobs[0]!.finish(50); await tick();
  const peer = read(0);
  assert.equal(jobs.length, 2, 'old cleanup cannot delete the pending replacement');
  jobs[1]!.finish(2400);
  for (const values of await Promise.all([retry, peer, read(0)])) assert.ok(values.every(value => value === 2400));
  assert.ok((await read(0)).every(value => value === 2400), 'late canceled data cannot enter the cache');
  assert.equal(jobs.length, 2);
});

test('geographic reads stay limited to four and canceled queued jobs never start', async t => {
  const { jobs, read } = fixture(t);
  const active = [0, 1, 2, 3].map(id => read(id));
  const controller = new AbortController();
  const canceled = assert.rejects(read(4, controller), { name: 'AbortError' });
  const next = read(5);
  assert.equal(jobs.length, 4);
  controller.abort(); await canceled;
  jobs[0]!.finish(); await active[0]; await tick();
  assert.equal(jobs.length, 5, 'only the surviving queued reader starts');
  jobs.slice(1).forEach(job => job.finish());
  const values = await Promise.all([...active, next]);
  assert.ok(values.every(grid => grid.every(height => height === 1200)));
  assert.equal(jobs.length, 5);
});

test('completed-cache pressure never evicts a pending geographic read and still bounds finished grids', async t => {
  const { jobs, read } = fixture(t);
  const pending = read(0);
  for (let id = 1; id <= 33; id++) {
    const request = read(id);
    assert.equal(jobs.length, id + 1);
    jobs.at(-1)!.finish();
    await request;
  }
  const peer = read(0);
  assert.equal(jobs.length, 34, 'cache eviction cannot start a second read for the pending grid');
  jobs[0]!.finish(); await Promise.all([pending, peer]);
  await read(0);
  assert.equal(jobs.length, 34, 'the recently completed grid remains warm');
  const cold = read(1);
  assert.equal(jobs.length, 35, 'the oldest completed grid was evicted from the 32-entry cache');
  jobs.at(-1)!.finish(); await cold;
});

test('failed and already canceled geographic reads leave no poisoned cache entry', async t => {
  const { jobs, read } = fixture(t), controller = new AbortController();
  controller.abort();
  await assert.rejects(read(0, controller), { name: 'AbortError' });
  assert.equal(jobs.length, 0);
  const failed = assert.rejects(read(0), /Invalid archive/);
  jobs[0]!.fail(new Error('Invalid archive')); await failed;
  const retry = read(0);
  assert.equal(jobs.length, 2);
  jobs[1]!.finish();
  assert.ok((await retry).every(value => value === 1200));
});
