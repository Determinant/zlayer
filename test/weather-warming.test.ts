import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WeatherCache } from '../tools/weather-server/cache';
import { discover } from '../tools/weather-server/discovery';
import { forecastResource } from '../tools/weather-server/processing';
import { HttpError, InvalidForecastSourceError, resourceFor } from '../tools/weather-server/routes';
import { digest, type Payload } from '../tools/weather-server/upstream';
import { createForecastWarming, PUBLISHED_CATALOG } from '../tools/weather-server/warming';
import type { NativeManifest } from '../src/layers/weather-awc/grids/native-source';
import { nativeForecastFiles } from './fixtures/awc-native.mjs';

const files = nativeForecastFiles(), runTime = Date.UTC(2026, 8, 22, 20);
for (const invalid of [true, false]) test(`forecast updates ${invalid ? 'rediscover invalid sources' : 'resume transient failures'} while retaining published files`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zlayer-warming-')), shutdown = new AbortController();
  let now = runTime + 3600000, version = 0, catalogs = 0, failure: Error | undefined;
  const payload = (body: Buffer): Payload => ({ body, sha256: digest(body), status: 200, checkedAt: now, headers: {} });
  const template = await discover(async path => payload(files.get('/weather/noaa/' + path)!), 'clouds', shutdown.signal, now);
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
