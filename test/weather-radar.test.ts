import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { isRadarCatalog, isRadarContours, RADAR_MAX_AGE, RADAR_HISTORY_MS } from '@zlayer/contracts';
import { decodeMrms, decodeTdwr, prepareRadar } from '../tools/weather-server/radar-decode';
import { digest } from '../tools/weather-server/upstream';
import { radarKey, radarKeys, radarHistory, tdwrUrl } from '../tools/weather-server/radar';
import { createWeatherServer } from '../tools/weather-server/server';
import { resourceFor } from '../tools/weather-server/routes';
import { currentRadar, radarTimes } from '../src/layers/weather-awc/radar/time';
import { forecastStops, HOUR } from '../src/layers/weather-awc/time';
import { weatherTimeScale } from '../src/layers/weather-awc/time-scale';
import { radarFixture, seedRadar } from './fixtures/radar';
import { RadarClient } from '../src/layers/weather-awc/radar/client';
import { RadarMotionClient } from '../src/layers/weather-awc/radar/motion-client';
import { radarFeatures } from '../src/layers/weather-awc/radar/geometry';

const mrmsSource = 'https://noaa-mrms-pds.s3.amazonaws.com/CONUS/MergedReflectivityQCComposite_00.50/20260924/MRMS_MergedReflectivityQCComposite_00.50_20260924-202439.grib2.gz';
const key = new URL(mrmsSource).pathname.slice(1);
const capture = (name: string) => readFile(new URL(`./fixtures/radar/${name}`, import.meta.url));

test('radar and storm-motion catalogs remain live when optional catalog storage is denied', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: {
    getItem: () => null, setItem() { throw new DOMException('Full', 'QuotaExceededError'); },
  } } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'window', previous) : Reflect.deleteProperty(globalThis, 'window'));
  const { catalog } = radarFixture(Date.now());
  const motion = { schemaVersion: 1, checkedAt: catalog.checkedAt, files: [], unavailable: [] };
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => Response.json(String(input).includes('/motion/') ? motion : catalog));
  const base = 'https://app.test/api/weather/radar/', signal = new AbortController().signal;
  assert.deepEqual(await new RadarClient(base).refresh(signal), catalog);
  assert.deepEqual(await new RadarMotionClient(base).refresh(signal), motion);
});

test('captured MRMS GRIB agrees with independent GDAL geometry, observation time and reflectivity', async () => {
  const raw = await capture('20260924-202439-mrms.grib2.gz'), field = decodeMrms(raw);
  assert.deepEqual([field.width, field.height], [7000, 3500]);
  assert.equal(field.observedAt, Date.parse('2026-09-24T20:24:39Z'));
  assert.deepEqual(field.project(.5, .5), [-129.995, 54.995]);
  assert.deepEqual(field.project(6999.5, 3499.5), [-60.005, 20.005]);
  let maximum = -Infinity;
  for (const value of field.values) maximum = Math.max(maximum, value);
  assert.equal(maximum, 65.5);
  assert.equal(field.values[1580 * 7000 + 3318], 39);
  assert.equal(field.values[1933 * 7000 + 3059], 42);
  const corrupt = gunzipSync(raw); corrupt[6] = 0;
  assert.throws(() => decodeMrms(gzipSync(corrupt)), /invalid NOAA radar/);
  assert.throws(() => decodeMrms(raw.subarray(0, 100)));
});

test('TDWR reads physical gates and missing codes, preserves partial sweeps, and rejects a different station', async () => {
  const raw = await capture('20260924-202234-tokc.level3');
  const field = decodeTdwr(raw, 'TOKC');
  assert.equal(field.width, 592); assert.equal(field.height, 362);
  assert.equal(field.observedAt, Date.parse('2026-09-24T20:22:34Z'));
  // Independent Python struct/bz2 read: first radial codes 0,43,29,29,24.
  assert.deepEqual(Array.from(field.values.slice(592, 597)), [-100, -11.5, -18.5, -18.5, -21]);
  assert.deepEqual(field.project(0, 1.5), [-97.51, 35.276]);
  const contours = prepareRadar(raw, 'TOKC', tdwrUrl('TOKC'), digest(raw));
  assert.ok(isRadarContours(contours)); assert.ok(contours.features[0]!.geometry.coordinates.length > 1000);
  const features = radarFeatures([contours]);
  assert.ok(features.some(feature => feature.geometry.coordinates.length > 1), 'captured echoes include holes');
  for (const level of contours.features) {
    assert.deepEqual(features.filter(feature => feature.properties.dbz === level.properties.dbz).map(feature => feature.geometry.coordinates),
      level.geometry.coordinates, 'rendering retains every source vertex, ring, hole and threshold without simplification');
  }
  const partial = decodeTdwr(await capture('20260924-202301-tatl.level3'), 'TATL');
  assert.equal(partial.height, 361, '358 measured radials, an explicit missing sector, and two seam rows');
  assert.throws(() => decodeTdwr(raw, 'TATL'));
  assert.throws(() => decodeTdwr(raw.subarray(0, 1000), 'TOKC'));
});

test('radar catalog validates source identity and bounds; stale live scans and future selections clear radar', () => {
  const { catalog, files } = radarFixture();
  assert.ok(isRadarCatalog(catalog));
  for (const body of files.values()) assert.ok(isRadarContours(JSON.parse(body.toString())));
  assert.equal(currentRadar(catalog, null, catalog.checkedAt).length, 2);
  assert.equal(currentRadar(catalog, catalog.checkedAt + 3600_000, catalog.checkedAt).length, 0);
  assert.equal(currentRadar(catalog, null, catalog.checkedAt + RADAR_MAX_AGE).length, 0);
  assert.equal(currentRadar(catalog, null, catalog.checkedAt - 600_000).length, 0);
  const bad = structuredClone(catalog); bad.files[0]!.path = '../../secrets'; assert.equal(isRadarCatalog(bad), false);
  bad.files = [catalog.files[0]!, catalog.files[0]!]; assert.equal(isRadarCatalog(bad), false);
  assert.throws(() => radarKey('<IsTruncated>true</IsTruncated>', '20260924', Date.now()));
  assert.equal(radarKey(`<IsTruncated>false</IsTruncated><Key>${key}</Key>`, '20260924', Date.parse('2026-09-24T20:25:00Z')), key);
  assert.throws(() => resourceFor('/api/weather/radar/latest.json?bbox=0,0,1,1'));
});

test('radar history selects past observations without future terminal scans, fills no gaps, and keeps Now between history and forecasts', () => {
  const { catalog } = radarFixture(undefined, true), now = catalog.checkedAt;
  assert.ok(isRadarCatalog(catalog));
  const times = radarTimes(catalog, now), selected = times[1]!;
  const shown = currentRadar(catalog, selected, now);
  assert.deepEqual(shown.map(f => f.site), ['CONUS', 'TOKC']);
  assert.equal(shown[0]!.observedAt, selected);
  assert.ok(shown.every(f => f.observedAt <= selected));
  assert.equal(currentRadar({ ...catalog, history: catalog.history!.filter(f => f.site === 'CONUS') }, selected, now).length, 1,
    'the current terminal image cannot stand in for missing historical terminal coverage');
  assert.deepEqual(currentRadar(catalog, now - 45 * 60_000, now), [], 'a 19-minute gap is unavailable');
  assert.deepEqual(currentRadar(catalog, selected, now + RADAR_HISTORY_MS), []);
  assert.deepEqual(radarTimes(catalog, now + RADAR_HISTORY_MS), []);
  assert.deepEqual(forecastStops([...times, now + HOUR], now, selected, times), [...times, null, now + HOUR]);
  const replacement = { ...catalog.files[0]!, sha256: 'b'.repeat(64) };
  assert.equal(currentRadar({ ...catalog, files: [replacement], history: [catalog.files[0]!] }, null, now)[0]!.sha256, replacement.sha256);
  const duplicate = { ...catalog, history: [catalog.history![0]!, catalog.history![0]!] };
  assert.equal(isRadarCatalog(duplicate), false);
  assert.equal(isRadarCatalog({ ...catalog, checkedAt: now + RADAR_HISTORY_MS }), false, 'history window is bounded at publication');
});

test('radar history retains stable five-minute samples, prioritizes national coverage within its byte cap, and prunes elapsed scans', () => {
  const { catalog } = radarFixture(undefined, true), now = catalog.checkedAt;
  const files = [...catalog.history!, ...catalog.files];
  const budget = files.filter(f => f.site === 'CONUS').reduce((sum, f) => sum + f.byteLength, 0);
  const retained = radarHistory(files, now, budget);
  assert.ok(retained.every(f => f.site === 'CONUS'));
  assert.equal(retained.length, 5);
  assert.ok(retained.reduce((sum, f) => sum + f.byteLength, 0) <= budget);
  const first = retained[0]!, later = { ...first, observedAt: first.observedAt + 10_000, sha256: 'b'.repeat(64) };
  assert.deepEqual(radarHistory([first, later], now, budget), [first]);
  assert.deepEqual(radarHistory(files, now + RADAR_HISTORY_MS, budget), []);
  const oldKey = key.replace('202439', '192439');
  assert.deepEqual(radarKeys(`<IsTruncated>false</IsTruncated><Key>${oldKey}</Key><Key>${key}</Key>`, '20260924', Date.parse('2026-09-24T20:25:00Z')), [oldKey, key]);
});

test('mixed weather scale keeps five-minute history selectable and hourly forecasts compact, with reversible pointer coordinates', () => {
  const now = Date.parse('2026-09-24T21:00:00Z'), start = now - 2 * HOUR, end = now + 7 * 24 * HOUR;
  const scale = weatherTimeScale(start, end, now, true);
  assert.equal(scale.offset(now) - scale.offset(now - 5 * 60_000), 11);
  assert.equal(scale.offset(now + HOUR) - scale.offset(now), 11);
  for (const time of [start, now - 62 * 60_000, now, now + 3 * HOUR, end]) assert.ok(Math.abs(scale.timeAt(scale.position(time) / 100) - time) < 1);
  assert.equal(weatherTimeScale(start, end, now, false).offset(start + HOUR), 11);
});

test('restoring missing history preserves current radar and the original source-check time', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zlayer-radar-restore-'));
  const fixture = radarFixture(undefined, true);
  let now = fixture.catalog.checkedAt;
  const options = { directory, startUpdates: false, now: () => now,
    fetch: (async () => { throw new Error('Restore must not acquire source data'); }) as typeof fetch };
  let app = await createWeatherServer(options);
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  await seedRadar(app.cache);
  const missing = fixture.catalog.history![0]!;
  await app.cache.discard(resourceFor(`/api/weather/radar/${missing.path}`));
  await app.close(); now += 60_000;
  app = await createWeatherServer(options);
  assert.equal(app.radar.status.ready, true);
  const payload = await app.cache.read(resourceFor('/api/weather/radar/latest.json'));
  const catalog = JSON.parse(payload!.body.toString());
  assert.ok(isRadarCatalog(catalog));
  assert.equal(catalog.checkedAt, fixture.catalog.checkedAt);
  assert.equal(payload!.checkedAt, fixture.catalog.checkedAt);
  assert.deepEqual(catalog.files, fixture.catalog.files);
  assert.ok(!catalog.history!.some(f => f.path === missing.path));
});

test('radar HTTP only reads prepared files; refresh reuses scans, failed sites stay independent and restart restores the catalog', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zlayer-radar-'));
  let now = Date.parse('2026-09-24T20:25:00Z'), reads = 0, offline = false;
  const national = await capture('20260924-202439-mrms.grib2.gz'), terminal = await capture('20260924-202234-tokc.level3');
  // A synthetic older timestamp on the captured field exercises real historical
  // acquisition/decoding without another multi-megabyte repository fixture.
  const oldNational = gunzipSync(national); oldNational[16 + 16] = 19;
  const historyRaw = gzipSync(oldNational), historyKey = key.replace('202439', '192439');
  const options = { directory, startUpdates: false, spacing: 0, now: () => now,
    fetch: (async (input: string | URL | Request) => {
      reads++; if (offline) return new Response(null, { status: 503 });
      const url = String(input);
      if (url.includes('?list-type')) return new Response(`<IsTruncated>false</IsTruncated><Key>${historyKey}</Key><Key>${key}</Key>`);
      if (url === mrmsSource) return new Response(Uint8Array.from(national));
      if (url === mrmsSource.replace('202439', '192439')) return new Response(Uint8Array.from(historyRaw));
      if (url === tdwrUrl('TOKC')) return new Response(Uint8Array.from(terminal));
      return new Response(null, { status: 404 });
    }) as typeof fetch };
  let app = await createWeatherServer(options);
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const listen = async () => { await new Promise<void>(r => app.server.listen(0, '127.0.0.1', r)); const address = app.server.address(); assert.ok(address && typeof address !== 'string'); return `http://127.0.0.1:${address.port}`; };
  let origin = await listen();
  assert.equal((await fetch(`${origin}/api/weather/radar/latest.json`)).status, 503); assert.equal(reads, 0);
  app.radar.refresh(); await app.radar.close();
  app.radar.refresh(); await app.radar.close(); // Idle live slot prepares one history bucket.
  const response = await fetch(`${origin}/api/weather/radar/latest.json`), catalog = await response.json();
  assert.equal(response.status, 200); assert.ok(isRadarCatalog(catalog)); assert.equal(catalog.files.length, 2); assert.equal(catalog.unavailable.length, 44);
  const historical = catalog.history?.find(f => f.source.endsWith('192439.grib2.gz'));
  assert.ok(historical, 'background preparation backfills national history');
  assert.equal(currentRadar(catalog, historical.observedAt, now)[0]!.sha256, historical.sha256);
  const before = reads;
  for (const file of [...catalog.files, historical]) {
    const result = await fetch(`${origin}/api/weather/radar/${file.path}`);
    assert.equal(result.headers.get('X-Weather-Cache'), 'HIT');
    const body = Buffer.from(await result.arrayBuffer()); assert.equal(digest(body), file.sha256); assert.ok(isRadarContours(JSON.parse(body.toString())));
  }
  assert.equal(reads, before, 'queries never acquire or process radar');
  now += 61_000; app.radar.refresh(); await app.radar.close();
  const refreshed = await (await fetch(`${origin}/api/weather/radar/latest.json`)).json();
  assert.deepEqual(refreshed.files, catalog.files, 'same raw hash reuses immutable prepared scans');
  assert.deepEqual(refreshed.history, catalog.history, 'unchanged history reuses prepared files');
  assert.ok(refreshed.checkedAt > catalog.checkedAt);
  await app.close(); app = await createWeatherServer(options); origin = await listen();
  assert.equal(app.radar.status.ready, true);
  assert.equal(app.radar.status.historyScans, catalog.history!.length);
  offline = true; now += 61_000; app.radar.refresh(); await app.radar.close();
  const saved = await (await fetch(`${origin}/api/weather/radar/latest.json`)).json();
  assert.deepEqual(saved.files, catalog.files); assert.ok(saved.unavailable.includes('CONUS'));
  now += RADAR_MAX_AGE; app.radar.refresh(); await app.radar.close();
  const expired = await (await fetch(`${origin}/api/weather/radar/latest.json`)).json();
  assert.deepEqual(currentRadar(expired, null, now), [], 'failed refresh cannot make observations current again');
  assert.equal(currentRadar(expired, historical.observedAt, now)[0]!.sha256, historical.sha256, 'live expiration does not erase usable history');
  now += RADAR_HISTORY_MS; app.radar.refresh(); await app.radar.close();
  const pruned = await (await fetch(`${origin}/api/weather/radar/latest.json`)).json();
  assert.deepEqual(pruned.history, [], 'expired history leaves the published catalog');
});
