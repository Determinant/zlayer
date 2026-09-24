import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tsImport } from 'tsx/esm/api';
import { isNativeManifest, type NativeManifest, type NativeFrame } from '../src/layers/weather-awc/grids/native-source';
import { gridKey, gridCell } from '../src/layers/weather-awc/grids/format';
import { inflatePacked, unpackGrid, readBand } from '../src/layers/weather-awc/grids/packed';
import { GRID_BELOW_GROUND, isAwcAdvisorySnapshot } from '@zlayer/contracts';
import { digest } from '../tools/weather-server/upstream';

// Query-bearing tsx module URLs must still select the TypeScript CPU worker
// rather than a nonexistent built entry.
const { fixtureWeather } = await tsImport(new URL('./fixtures/weather-server.ts', import.meta.url).href, import.meta.url) as typeof import('./fixtures/weather-server');

const artifact = (manifest: NativeManifest, frame: NativeFrame) => {
  const level = frame.pressureHpa ? `p${frame.pressureHpa}` : frame.altitudeFtMsl ?? 0;
  return `/api/weather/grids/${manifest.product}/${manifest.runTime}-${(frame.validTime - manifest.runTime) / 3600000}-${level}-${digest(Buffer.from(gridKey(manifest, frame)))}.zwp.gz`;
};
function gate<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('server shares forecast preparation, retains exact values and reuses saved results after restart', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zlayer-prepared-'));
  let rawReads = 0, app = await fixtureWeather(directory, { onRaw: () => { rawReads++; } });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  async function listen() {
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address(); assert.ok(address && typeof address === 'object');
    return `http://127.0.0.1:${address.port}`;
  }
  let origin = await listen();
  await app.warmAdvisories();
  for (const product of ['gairmet', 'sigmet', 'cwa']) {
    const response = await fetch(`${origin}/api/weather/advisories/${product}.json`);
    assert.equal(response.status, 200);
    const value: unknown = await response.json(); assert.ok(isAwcAdvisorySnapshot(value));
    assert.equal(value.product, product);
    if (product === 'gairmet') assert.equal(value.frameTimes.length, 5);
  }
  const clouds = await app.warmForecast('clouds', manifest => [manifest.frames[1]!]);
  assert.ok(isNativeManifest(clouds)); assert.equal(rawReads, 1, 'one combined HRRR block serves all five cloud fields');
  const path = artifact(clouds, clouds.frames[1]!);
  const responses = await Promise.all(Array.from({ length: 4 }, () => fetch(origin + path)));
  const sourceTime = responses[0]!.headers.get('x-weather-checked-at');
  let compressed: ArrayBuffer | undefined;
  for (const response of responses) {
    assert.equal(response.status, 200, await response.clone().text().then(t => t.slice(0, 200)));
    const bytes = await response.arrayBuffer();
    assert.equal(digest(new Uint8Array(bytes)), response.headers.get('x-weather-sha256'));
    compressed ??= bytes;
  }
  assert.equal(rawReads, 1, 'HTTP readers use prepared files without more source acquisition');
  const bands = unpackGrid(await inflatePacked(compressed!, clouds), clouds), cell = gridCell(clouds, -100, 38)!;
  assert.equal(readBand(bands[0]!)(cell), 75);
  const warm = await fetch(origin + path); await warm.arrayBuffer(); assert.equal(warm.headers.get('x-weather-cache'), 'HIT');
  assert.equal(warm.headers.get('x-weather-checked-at'), sourceTime);
  const wrong = await fetch(origin + path.replace(/-[a-f0-9]{64}\.zwp/, '-' + '0'.repeat(64) + '.zwp'));
  assert.equal(wrong.status, 404); await wrong.arrayBuffer(); assert.equal(rawReads, 1);
  const beforeIcing = rawReads;
  const icing = await app.warmForecast('icing', manifest => manifest.frames.filter(frame =>
    frame.validTime === manifest.runTime + 3600000 && [500, 8000].includes(frame.altitudeFtMsl!)));
  assert.ok(isNativeManifest(icing));
  assert.equal(rawReads - beforeIcing, 2, 'one combined IFI block and one terrain record serve both altitudes');
  for (const altitude of [500, 8000]) {
    const frame = icing.frames.find(f => f.validTime === icing.runTime + 3600000 && f.altitudeFtMsl === altitude)!;
    const response = await fetch(origin + artifact(icing, frame)); assert.equal(response.status, 200);
    const bands = unpackGrid(await inflatePacked(await response.arrayBuffer(), icing), icing);
    assert.deepEqual(bands.map(b => readBand(b)(cell)), altitude === 500 ? [GRID_BELOW_GROUND, GRID_BELOW_GROUND, GRID_BELOW_GROUND] : [70, 3, .25]);
  }
  const winds = await app.warmForecast('winds', manifest => manifest.frames.filter(frame =>
    frame.validTime === manifest.runTime + 3600000 && [850, 500].includes(frame.pressureHpa!)));
  assert.ok(isNativeManifest(winds));
  for (const pressure of [850, 500]) {
    const frame = winds.frames.find(frame => frame.validTime === winds.runTime + 3600000 && frame.pressureHpa === pressure)!;
    const response = await fetch(origin + artifact(winds, frame)); assert.equal(response.status, 200);
    const bands = unpackGrid(await inflatePacked(await response.arrayBuffer(), winds), winds);
    assert.ok(Math.abs(readBand(bands[3]!)(cell) - 10) < .001);
    assert.ok(readBand(bands[0]!)(cell) > 0);
  }
  await app.close();
  const before = rawReads;
  app = await fixtureWeather(directory, { onRaw: () => { rawReads++; } }); origin = await listen();
  const restored = await fetch(origin + path);
  assert.equal(restored.status, 200); assert.equal(restored.headers.get('x-weather-cache'), 'HIT');
  assert.equal(digest(new Uint8Array(await restored.arrayBuffer())), digest(new Uint8Array(compressed!)));
  assert.equal(rawReads, before);
});

test('forecast products prepare concurrently without publishing unfinished catalogs', { timeout: 20_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zlayer-parallel-prepared-'));
  const cloudStarted = gate(), icingStarted = gate(), releaseCloud = gate();
  const app = await fixtureWeather(directory, { onRaw: async (_signal, path) => {
    if (path.includes('wrfsfcf01.grib2')) { cloudStarted.resolve(); await releaseCloud.promise; }
    if (path.includes('/dafs/')) icingStarted.resolve();
  } });
  t.after(async () => { releaseCloud.resolve(); await app.close(); await rm(directory, { recursive: true, force: true }); });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address(); assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const first = app.warmForecast('clouds', manifest => [manifest.frames[1]!]);
  await cloudStarted.promise;
  const second = app.warmForecast('icing', manifest => [manifest.frames.find(frame => frame.altitudeFtMsl === 8000)!]);
  await icingStarted.promise;
  assert.equal((await fetch(origin + '/api/weather/grids/clouds.json')).status, 503, 'HTTP does not publish an unfinished catalog');
  releaseCloud.resolve();
  await Promise.all([first, second]);
  assert.equal((await fetch(origin + '/api/weather/grids/clouds.json')).status, 200);

});

test('HTTP catalog requests never start discovery or preparation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zlayer-read-only-'));
  let rawReads = 0;
  const app = await fixtureWeather(directory, { onRaw: () => { rawReads++; } });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address(); assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  for (const product of ['clouds', 'icing', 'winds']) {
    const response = await fetch(`${origin}/api/weather/grids/${product}.json`);
    assert.equal(response.status, 503); await response.arrayBuffer();
  }
  assert.equal(rawReads, 0);
  assert.equal(app.cache.stats.entries, 0, 'HTTP does not acquire source indexes');
  assert.equal(app.cache.stats.updating, 0, 'no all-altitude preparation runs in the background');
});
