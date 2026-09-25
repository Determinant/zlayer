import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isProgsCoverageCatalog, progsCoverageImageSize, progsCoverageSource, PROGS_COVERAGE_SOURCE, type ProgsCoverageCatalog } from '@zlayer/contracts';
import { createWeatherServer } from '../tools/weather-server/server';
import { digest } from '../tools/weather-server/upstream';
import { resourceFor } from '../tools/weather-server/routes';
import { workerJob } from '../tools/weather-server/worker-job';
import { ProgsCoverageClient } from '../src/layers/weather-awc/progs/coverage-client';
import { progsCoverageFrame } from '../src/layers/weather-awc/progs/coverage-time';
import { surfaceCatalog } from './fixtures/wpc';
import { coveragePng } from './fixtures/progs-coverage';
import { WEATHER_NOW } from './fixtures/awc-advisories';
import { cacheFixture } from './helpers/cache';

const HOUR = 3600_000, signal = () => new AbortController().signal;
function catalog(bytes = coveragePng()): ProgsCoverageCatalog {
  const sourceCatalog = JSON.stringify(surfaceCatalog()), sha256 = digest(bytes);
  return { schemaVersion: 1, source: PROGS_COVERAGE_SOURCE, sourceHash: digest(Buffer.from(sourceCatalog)), sourceCatalog,
    checkedAt: WEATHER_NOW, frames: surfaceCatalog().prog.map(chart => {
      const validTime = chart.vsecs * 1000, chartReferenceTime = validTime - chart.fhr * HOUR;
      return { validTime, chartReferenceTime, source: progsCoverageSource(validTime, chartReferenceTime), checkedAt: WEATHER_NOW,
        ...(chart.fhr === 168 ? {} : { file: { sha256, byteLength: bytes.length, path: `coverage/${sha256}.png` } }) };
    }) };
}
function browser(t: TestContext) {
  const values = new Map<string, string>(), navigator = { onLine: true, locks: globalThis.navigator.locks };
  for (const [name, value] of Object.entries({ navigator, window: { localStorage: {
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value),
  } } })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => descriptor ? Object.defineProperty(globalThis, name, descriptor) : Reflect.deleteProperty(globalThis, name));
  }
  return { values, navigator };
}

test('coverage identity is pinned to native chart times and missing images break selection intervals', () => {
  const value = catalog();
  assert.ok(isProgsCoverageCatalog(value));
  for (const patch of [{ path: '../untrusted.png' }, { sha256: 'wrong' }, { byteLength: 2 ** 30 }]) {
    const invalid = structuredClone(value); Object.assign(invalid.frames[0]!.file!, patch);
    assert.equal(isProgsCoverageCatalog(invalid), false);
  }
  for (const patch of [{ source: 'https://example.com/image.png' }, { chartReferenceTime: WEATHER_NOW + HOUR }, { validTime: WEATHER_NOW + 1 }]) {
    const invalid = structuredClone(value); Object.assign(invalid.frames[0]!, patch);
    assert.equal(isProgsCoverageCatalog(invalid), false);
  }
  assert.equal(progsCoverageFrame(value, null, WEATHER_NOW), value.frames[0]);
  assert.equal(progsCoverageFrame(value, null, WEATHER_NOW + 6 * HOUR), undefined);
  assert.equal(progsCoverageFrame(value, null, value.frames[0]!.validTime - 1), undefined);
  const first = value.frames[1]!, missing = value.frames[2]!;
  delete missing.file;
  assert.equal(progsCoverageFrame(value, first.validTime + 1, WEATHER_NOW), first);
  assert.equal(progsCoverageFrame(value, missing.validTime, WEATHER_NOW), missing);
  assert.equal(progsCoverageFrame(value, missing.validTime + HOUR, WEATHER_NOW)?.file, undefined);
  assert.equal(progsCoverageFrame(value, value.frames.at(-1)!.validTime + 1, WEATHER_NOW), undefined);
});

test('captured AWC NDFD PNG validates without resampling; corrupt chunks and unsupported dimensions fail', async () => {
  const bytes = await readFile(new URL('./fixtures/ndfd/20260925_03_F000_ndfd_sfc_wx_m.png', import.meta.url));
  assert.deepEqual(progsCoverageImageSize(bytes), { width: 1800, height: 1200 });
  const worker = new URL('../tools/weather-server/progs-coverage-worker.ts', import.meta.url);
  assert.equal(await workerJob(worker, [bytes, coveragePng()], signal()), true);
  const corrupt = Buffer.from(bytes); corrupt[corrupt.length - 20] = corrupt[corrupt.length - 20]! ^ 1;
  await assert.rejects(workerJob(worker, [corrupt], signal()), /CRC|checksum|data|stream|length/i);
  const wrong = Buffer.from(bytes); wrong.writeUInt32BE(3000, 16);
  assert.throws(() => progsCoverageImageSize(wrong), /geometry/);
  assert.throws(() => progsCoverageImageSize(bytes.subarray(0, 40)), /PNG/);
});

test('server publishes validated coverage independently, preserves prior data on failures, accepts corrections and restores without acquisition', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zlayer-coverage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = WEATHER_NOW, png = coveragePng(), mode = 'good', reads = 0;
  const fetcher: typeof fetch = async input => {
    reads++;
    const path = new URL(String(input)).pathname;
    if (path === '/api/data/progchart') return Response.json(surfaceCatalog());
    if (path.includes('_F168_')) return new Response(null, { status: 404 });
    if (mode === 'outage') return new Response(null, { status: 500 });
    return new Response(mode === 'malformed' ? Uint8Array.from([1, 2, 3]) : png, { headers: { 'content-type': 'image/png' } });
  };
  const options = { directory, startUpdates: false, spacing: 0, now: () => now, fetch: fetcher };
  const app = await createWeatherServer(options); t.after(() => app.close());
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address() as { port: number }, origin = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${origin}/api/weather/progs/coverage.json`)).status, 503);
  assert.equal(reads, 0, 'HTTP never starts coverage acquisition');
  const refresh = async () => { app.coverage.refresh(); await app.coverage.close(); };
  await refresh();
  assert.equal(app.coverage.status.ready, true);
  assert.equal(app.progs.status.analysis!.ready, false, 'pressure-chart readiness does not gate coverage');
  const first = await (await fetch(`${origin}/api/weather/progs/coverage.json`)).json() as ProgsCoverageCatalog;
  assert.ok(isProgsCoverageCatalog(first));
  assert.equal(first.frames.at(-1)!.file, undefined);
  const path = `/api/weather/progs/${first.frames[0]!.file!.path}`;
  const response = await fetch(origin + path);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(digest(new Uint8Array(await response.arrayBuffer())), first.frames[0]!.file!.sha256);
  const requests = reads;
  assert.equal((await fetch(origin + path, { method: 'HEAD' })).status, 200);
  assert.equal((await fetch(origin + path + '?time=other')).status, 400);
  assert.equal(reads, requests);
  for (const failure of ['malformed', 'outage']) {
    now += 6 * 60_000; mode = failure; await refresh();
    assert.ok(app.coverage.status.error);
    assert.deepEqual(await (await fetch(`${origin}/api/weather/progs/coverage.json`)).json(), first);
  }
  mode = 'good'; png = coveragePng(1); now += 6 * 60_000; await refresh();
  const corrected = await (await fetch(`${origin}/api/weather/progs/coverage.json`)).json() as ProgsCoverageCatalog;
  assert.notEqual(corrected.frames[0]!.file!.sha256, first.frames[0]!.file!.sha256);
  assert.equal(corrected.frames[0]!.chartReferenceTime, first.frames[0]!.chartReferenceTime);
  assert.equal((await fetch(origin + path)).status, 200, 'preceding readers retain their immutable files');
  await app.close();
  const beforeRestart = reads, restarted = await createWeatherServer(options); t.after(() => restarted.close());
  assert.equal(restarted.coverage.status.ready, true);
  restarted.coverage.refresh(); await restarted.coverage.close();
  assert.equal(reads, beforeRestart);
  assert.equal((await restarted.cache.read(resourceFor('/api/weather/progs/coverage.json')))!.checkedAt, corrected.checkedAt);
});

test('client authenticates saved images, avoids unchanged transfers, and reopens offline without claiming an evicted image', async t => {
  const env = browser(t), { stored } = cacheFixture(t, 'zlayers-plugin-files-v1:weather-awc:progs-coverage');
  t.mock.timers.enable({ apis: ['Date'], now: WEATHER_NOW });
  const png = coveragePng(), value = catalog(png); let images = 0;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    assert.equal(env.navigator.onLine, true, 'offline restoration must not fetch');
    if (String(input).endsWith('coverage.json')) return Response.json(value);
    images++; return new Response(png);
  });
  const client = new ProgsCoverageClient('https://test/api/weather/progs/');
  assert.deepEqual(await client.refresh(signal()), value);
  assert.equal(images, 1, 'identical content at multiple native times shares one download');
  await client.refresh(signal()); assert.equal(images, 1);
  env.navigator.onLine = false;
  const reopened = new ProgsCoverageClient(client.baseUrl);
  assert.equal(reopened.restore().restored, true);
  assert.deepEqual(reopened.restore().snapshot, value);
  assert.equal(digest(new Uint8Array(await reopened.load(value.frames[0]!.file!, signal()))), digest(png));
  const [key, saved] = [...stored][0]!, corrupt = png.slice(); corrupt[50] = corrupt[50]! ^ 1;
  stored.set(key, new Response(corrupt, { headers: saved.headers }));
  await assert.rejects(reopened.load(value.frames[0]!.file!, signal()), /checksum/);
  stored.clear();
  await assert.rejects(new ProgsCoverageClient(client.baseUrl).load(value.frames[0]!.file!, signal()));
  assert.equal(images, 1);
});

test('denied image saves retain live coverage and preserve the last restorable catalog', async t => {
  const env = browser(t), { cache, stored } = cacheFixture(t, 'zlayers-plugin-files-v1:weather-awc:progs-coverage');
  t.mock.timers.enable({ apis: ['Date'], now: WEATHER_NOW });
  let png = coveragePng(), value = catalog(png);
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => String(input).endsWith('coverage.json') ? Response.json(value) : new Response(png));
  const client = new ProgsCoverageClient('https://test/api/weather/progs/');
  await client.refresh(signal());
  const saved = [...env.values.values()][0];
  png = coveragePng(1); value = catalog(png);
  let release!: () => void, ready!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const usable = new Promise<void>(resolve => { ready = resolve; });
  t.mock.method(cache, 'put', async () => { await blocked; throw new Error('Quota denied'); });
  const refreshing = client.refresh(signal(), ready);
  await usable;
  assert.equal(digest(new Uint8Array(await client.load(value.frames[0]!.file!, signal()))), digest(png), 'validated image is usable while its optional save is pending');
  release();
  assert.deepEqual(await refreshing, value);
  assert.equal([...env.values.values()][0], saved);
  assert.equal(stored.size, 1);
  assert.equal(digest(new Uint8Array(await client.load(value.frames[0]!.file!, signal()))), digest(png));
});
