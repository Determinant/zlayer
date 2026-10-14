import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WeatherCache } from '../tools/info-server/cache';
import { discover } from '../tools/info-server/discovery';
import { forecastResource } from '../tools/info-server/processing';
import { HttpError, InvalidForecastSourceError, resourceFor } from '../tools/info-server/weather-resources';
import { digest, type Payload } from '../tools/info-server/upstream';
import { createForecastWarming, PUBLISHED_CATALOG } from '../tools/info-server/warming';
import { InfoMetrics } from '../tools/info-server/metrics';
import type { NativeManifest } from '../src/layers/weather-awc/grids/native-source';
import { nativeForecastFiles } from './fixtures/awc-native.mjs';

const files = nativeForecastFiles(), runTime = Date.UTC(2026, 8, 22, 20);
const discoveredBody = (path: string) => {
  const raw = files.get('/weather/noaa/' + path)!;
  return path.endsWith('.idx') ? raw : Buffer.from(JSON.stringify({ byteLength: raw.length, etag: `"${digest(raw)}"` }));
};

test('forecast discovery cannot roll back the published run, including after restart', async t => {
  const metrics = new InfoMetrics(); t.after(() => metrics.close());
  const directory = await mkdtemp(join(tmpdir(), 'zlayer-forecast-rollback-')), shutdown = new AbortController();
  let now = runTime + 3600_000, older = false, correction = false, conversions = 0, discoveries = 0;
  const payload = (body: Buffer): Payload => ({ body, sha256: digest(body), status: 200, checkedAt: now, headers: {} });
  const template = await discover(async path => payload(discoveredBody(path)), 'clouds', shutdown.signal, now);
  const options = { directory, maxBytes: 1024 * 1024, now: () => now, load: async () => { throw new Error('No acquisition'); } };
  let cache = new WeatherCache(options); await cache.restore();
  const processing = { concurrency: 2, catalog: async (product: string) => {
    if (product !== 'clouds') throw new HttpError(503, 'Other products unavailable');
    discoveries++;
    const manifest = structuredClone(template); manifest.checkedAt = manifest.publishedAt = now;
    if (older) {
      manifest.runTime -= 3600_000; manifest.generation = `clouds-${manifest.runTime}`;
      for (const frame of manifest.frames) {
        frame.validTime -= 3600_000;
        for (const record of Object.values(frame.records)) record.path = record.path.replace('t20z', 't19z');
        frame.sources = frame.sources.map(source => source.replace('t20z', 't19z'));
      }
    }
    if (correction) for (const frame of manifest.frames) for (const record of Object.values(frame.records)) {
      record.version = { byteLength: record.version!.byteLength, etag: '"corrected-values-unchanged-index"' };
    }
    return payload(Buffer.from(JSON.stringify(manifest)));
  }, forecast: async (_manifest: NativeManifest, frame: NativeManifest['frames'][number]) => {
    conversions++; return payload(Buffer.from(JSON.stringify(frame)));
  } };
  let warming = createForecastWarming(cache, processing, shutdown.signal, { now: () => now, metrics });
  t.after(async () => { shutdown.abort(); await warming.close(); await cache.drain(); await rm(directory, { recursive: true, force: true }); });
  const resource = resourceFor('/api/weather/grids/clouds.json');
  warming.refresh(); await warming.close();
  const published = (await cache.read(resource))!, prepared = conversions;
  assert.equal(warming.status.clouds!.ready, true);
  cache = new WeatherCache(options); await cache.restore();
  warming = createForecastWarming(cache, processing, shutdown.signal, { now: () => now, metrics }); await warming.restore();
  warming.refresh(); await warming.close();
  assert.equal(discoveries, 1, 'restart waits out the remaining source-check interval');
  assert.equal(conversions, prepared);
  assert.equal(warming.status.clouds!.nextAttemptAt, now + 6 * 60_000);
  older = true;
  for (let attempt = 0; attempt < 2; attempt++) {
    now += 6 * 60_000; warming.refresh(); await warming.close();
    assert.deepEqual(await cache.read(resource), published);
    assert.equal(warming.status.clouds!.runTime, runTime);
    assert.equal(warming.status.clouds!.ready, true);
    assert.match(warming.status.clouds!.error!, /older forecast run/);
    assert.equal(conversions, prepared, 'older runs are rejected before conversion');
    assert.equal(metrics.status.operations['forecast.clouds']?.failed, attempt + 1, 'handled failures remain failures in timing metrics');
    cache = new WeatherCache(options); await cache.restore();
    warming = createForecastWarming(cache, processing, shutdown.signal, { now: () => now, metrics }); await warming.restore(); await cache.prune();
  }
  older = false; correction = true; now += 30_000; warming.refresh(); await warming.close();
  assert.equal(warming.status.clouds!.error, undefined);
  assert.equal(warming.status.clouds!.runTime, runTime, 'same-run corrections remain publishable');
  assert.ok(conversions > prepared);
  assert.notEqual((await cache.read(resource))!.sha256, published.sha256);
  now = runTime; older = true; correction = false;
  assert.equal(warming.status.clouds!.ready, false);
  warming.refresh(); await warming.close();
  assert.equal(warming.status.clouds!.error, undefined, 'a future-dated publication cannot veto a valid run after clock rollback');
  assert.equal(warming.status.clouds!.ready, true);
  assert.equal(warming.status.clouds!.runTime, runTime - 3600_000);
});
for (const invalid of [true, false]) test(`forecast updates ${invalid ? 'rediscover invalid sources' : 'resume transient failures'} while retaining published files`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zlayer-warming-')), shutdown = new AbortController();
  let now = runTime + 3600000, version = 0, catalogs = 0, failure: Error | undefined;
  const payload = (body: Buffer): Payload => ({ body, sha256: digest(body), status: 200, checkedAt: now, headers: {} });
  const template = await discover(async path => payload(discoveredBody(path)), 'clouds', shutdown.signal, now);
  const cache = new WeatherCache({ directory, maxBytes: 128 * 1024, now: () => now,
    load: async () => { throw new Error('Forecast reads must not acquire sources'); } });
  await cache.restore();
  const warming = createForecastWarming(cache, {
    concurrency: 4,
    catalog: async product => {
      if (product !== 'clouds') throw new HttpError(503, 'Other products unavailable');
      catalogs++;
      const manifest: NativeManifest = structuredClone(template);
      manifest.checkedAt = manifest.publishedAt = now;
      for (const frame of manifest.frames) for (const record of Object.values(frame.records)) record.indexHash = digest(Buffer.from(String(version)));
      return payload(Buffer.from(JSON.stringify(manifest)));
    },
    forecast: async (_manifest, frame) => {
      if (failure && frame.validTime === runTime + 3600000) throw failure;
      return payload(Buffer.from(JSON.stringify(frame)));
    },
  }, shutdown.signal, { now: () => now });
  t.after(async () => { shutdown.abort(); await warming.close(); await cache.drain(); await rm(directory, { recursive: true, force: true }); });
  const catalog = resourceFor('/api/weather/grids/clouds.json');
  warming.refresh(); await warming.close();
  const published = (await cache.read(catalog))!;
  assert.equal(published.headers['x-weather-catalog'], PUBLISHED_CATALOG);
  assert.equal(warming.status.clouds!.ready, true);
  const original = JSON.parse(published.body.toString()) as NativeManifest;
  const originalFiles = original.frames.map(frame => forecastResource(original, frame));

  now += 6 * 60_000; version++;
  failure = invalid ? new InvalidForecastSourceError('Invalid GRIB record') : new HttpError(503, 'Source temporarily unavailable', 30);
  warming.refresh(); await warming.close();
  assert.deepEqual((await cache.read(catalog))!.body, published.body, 'a failed candidate cannot replace the complete catalog');
  assert.ok(originalFiles.every(resource => cache.has(resource)), 'published files survive failed preparation');
  assert.equal(warming.status.clouds!.ready, true);
  assert.equal(catalogs, 2);

  now += 30_000; version++; failure = undefined;
  warming.refresh(); await warming.close();
  assert.equal(catalogs, invalid ? 3 : 2, 'only an invalid source discards its pinned candidate');
  const replacement = JSON.parse((await cache.read(catalog))!.body.toString()) as NativeManifest;
  assert.equal(replacement.frames[0]!.records.cloudCover!.indexHash, digest(Buffer.from(invalid ? '2' : '1')));
  assert.ok(replacement.frames.every(frame => cache.has(forecastResource(replacement, frame))), 'every published file is saved');
  assert.ok(originalFiles.every(resource => cache.has(resource)), 'preceding files remain available after replacement');
  assert.equal(warming.status.clouds!.error, undefined);
});

for (const recovery of ['same-run', 'new-run', 'clock-rollback']) test(`forecast transport recovery rediscovers ${recovery} and reuses prepared files`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zlayer-warming-recovery-')), shutdown = new AbortController();
  let now = runTime + 3600_000, version = 0, catalogs = 0, outage = false;
  const payload = (body: Buffer): Payload => ({ body, sha256: digest(body), status: 200, checkedAt: now, headers: {} });
  const template = await discover(async path => payload(discoveredBody(path)), 'clouds', shutdown.signal, now);
  const cache = new WeatherCache({ directory, maxBytes: 1024 * 1024, now: () => now, load: async () => assert.fail('No acquisition') });
  await cache.restore();
  const conversions = new Map<string, number>(), hash = (n: number) => digest(Buffer.from(String(n)));
  const warming = createForecastWarming(cache, { concurrency: 1,
    catalog: async product => {
      if (product !== 'clouds') throw new HttpError(503, 'Other products unavailable');
      catalogs++;
      const manifest = structuredClone(template), shift = version === 2 ? 3600_000 : 0;
      manifest.runTime += shift; manifest.generation = `clouds-${manifest.runTime}`;
      manifest.checkedAt = manifest.publishedAt = now;
      for (const frame of manifest.frames) {
        frame.validTime += shift;
        if (shift) frame.sources = frame.sources.map(path => path.replace('t20z', 't21z'));
        for (const record of Object.values(frame.records)) {
          record.indexHash = hash(version);
          if (shift) record.path = record.path.replace('t20z', 't21z');
        }
      }
      return payload(Buffer.from(JSON.stringify(manifest)));
    },
    forecast: async (manifest, frame) => {
      const version = frame.records.cloudCover!.indexHash;
      if (outage && version === hash(1) && frame.validTime === manifest.runTime + 3600_000) throw new HttpError(503, 'Old source unavailable');
      const key = `${version}/${frame.validTime}`; conversions.set(key, (conversions.get(key) ?? 0) + 1);
      return payload(Buffer.from(JSON.stringify(frame)));
    },
  }, shutdown.signal, { now: () => now });
  t.after(async () => { shutdown.abort(); await warming.close(); await cache.drain(); await rm(directory, { recursive: true, force: true }); });
  const catalog = resourceFor('/api/weather/grids/clouds.json');
  warming.refresh(); await warming.close();
  const original = (await cache.read(catalog))!;
  now += 6 * 60_000; version = 1; outage = true;
  warming.refresh(); await warming.close();
  for (let attempt = 0; attempt < 11; attempt++) {
    now += 30_000; warming.refresh(); await warming.close();
    assert.equal(catalogs, 2, 'short outages resume the candidate');
    assert.deepEqual(await cache.read(catalog), original, 'failed preparation leaves the complete publication intact');
  }
  if (recovery === 'new-run') version = 2;
  else outage = false;
  now += recovery === 'clock-rollback' ? -6 * 60_000 : 30_000;
  warming.refresh(); await warming.close();
  assert.equal(catalogs, 3, 'an aged or future candidate must not suppress discovery');
  assert.equal(warming.status.clouds!.error, undefined);
  assert.equal(warming.status.clouds!.ready, true);
  const next = JSON.parse((await cache.read(catalog))!.body.toString()) as NativeManifest;
  assert.equal(next.frames[0]!.records.cloudCover!.indexHash, hash(version));
  assert.ok(next.frames.every(frame => cache.has(forecastResource(next, frame))));
  assert.equal(conversions.get(`${hash(1)}/${runTime}`), recovery === 'clock-rollback' ? 2 : 1,
    'rediscovery reuses source-identical files unless clock rollback puts their check time in the future');
});
