import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AwcGridProduct, AwcGridFrame, AwcGridManifest } from '@zlayer/contracts';
import { discover, type ReadSource } from '../tools/weather-server/discovery';
import { HttpError, InvalidForecastIndexError, modelResource } from '../tools/weather-server/routes';
import { WeatherCache } from '../tools/weather-server/cache';
import { createProcessing } from '../tools/weather-server/processing';
import { digest, type Payload } from '../tools/weather-server/upstream';
import { isNativeManifest, modelPath } from '../src/layers/weather-awc/grids/native-source';
import { nativeForecastFiles } from './fixtures/awc-native.mjs';
import { selectForecast } from '../src/layers/weather-awc/grids/selection';
import { preparedSource } from '../src/layers/weather-awc/grids/prepared-client';
import { forecastResource } from '../tools/weather-server/processing';

const hour = 3600000, older = Date.UTC(2026, 8, 22, 20), latest = older + hour, now = latest + hour;
const signal = new AbortController().signal, files = nativeForecastFiles();
function source(change: (path: string, body: string) => string = (_path, body) => body) {
  const entries = new Map<string, Payload>(), calls: string[] = [];
  for (const run of [older, latest]) for (const product of ['clouds', 'winds', 'icing'] as const) {
    for (let lead = product === 'icing' ? 1 : 0; lead <= 18; lead++) {
      const template = files.get('/weather/noaa/' + modelPath(product, older, lead) + '.idx')!;
      const body = Buffer.from(template.toString().replaceAll('d=2026092220', run === latest ? 'd=2026092221' : 'd=2026092220'));
      entries.set(modelPath(product, run, lead) + '.idx', { body, status: 200, headers: {}, sha256: digest(body),
        checkedAt: now - (run === latest ? 55_000 : 1000) });
    }
  }
  const read: ReadSource = async (path, signal) => {
    signal.throwIfAborted(); calls.push(path);
    const entry = entries.get(path);
    if (!entry) throw new HttpError(404, 'Missing cycle');
    const body = Buffer.from(change(path, entry.body.toString()));
    return { ...entry, body, sha256: digest(body) };
  };
  return { read, calls };
}

test('discovery checks the entire horizon, fields and terrain before choosing a cycle', async () => {
  const cases: { product: AwcGridProduct; broken: string; change: (body: string) => string }[] = [
    { product: 'clouds', broken: modelPath('clouds', latest, 5), change: () => { throw new HttpError(404, 'Missing intermediate lead'); } },
    { product: 'clouds', broken: modelPath('clouds', latest, 18), change: body => body.replace(':TCDC:', ':UNKNOWN:') },
    { product: 'clouds', broken: modelPath('clouds', latest, 5), change: body => body.replaceAll('5 hour fcst', '4 hour fcst') },
    { product: 'clouds', broken: modelPath('clouds', latest, 5), change: body => body.replaceAll('d=2026092221', 'd=2026092220') },
    { product: 'clouds', broken: modelPath('clouds', latest, 5), change: () => { throw new InvalidForecastIndexError('Incomplete index'); } },
    { product: 'winds', broken: modelPath('clouds', latest, 0), change: () => { throw new HttpError(404, 'Missing terrain'); } },
    { product: 'icing', broken: modelPath('clouds', latest, 0), change: body => body.replace(':HGT:surface:', ':UNKNOWN:surface:') },
  ];
  for (const scenario of cases) {
    const { read } = source((path, body) => path === scenario.broken + '.idx' ? scenario.change(body) : body);
    const manifest = await discover(read, scenario.product, signal, now);
    assert.equal(manifest.runTime, older);
    assert.ok(isNativeManifest(manifest));
    assert.equal(manifest.checkedAt, now - 1000, 'rejected-cycle checks cannot age the accepted catalog');
  }
});

test('discovery does not substitute cycles for immutable selections, outages, backoff or cancellation', async () => {
  const missing = modelPath('clouds', latest, 5) + '.idx';
  const pinned = source((path, body) => { if (path === missing) throw new HttpError(404, 'Missing selection'); return body; });
  await assert.rejects(discover(pinned.read, 'clouds', signal, now, { runTime: latest, lead: 5 }), { status: 404 });
  assert.deepEqual(pinned.calls, [missing]);
  for (const error of [new HttpError(503, 'Backing off', 30), new HttpError(502, 'Unavailable'), new TypeError('Network failed')]) {
    const failed = source(() => { throw error; });
    await assert.rejects(discover(failed.read, 'clouds', signal, now), cause => cause === error);
    assert.equal(failed.calls.length, 1);
  }
  const canceled = new AbortController(), canceledSource = source(); canceled.abort();
  await assert.rejects(discover(canceledSource.read, 'clouds', canceled.signal, now), { name: 'AbortError' });
  assert.equal(canceledSource.calls.length, 0);
  const absent = source(() => { throw new HttpError(404, 'No cycle'); });
  await assert.rejects(discover(absent.read, 'clouds', signal, now), /No complete recent NOAA model run/);
  assert.equal(absent.calls.length, 6, 'fallback remains bounded');
});

test('catalog assembly refreshes an index that would expire while the remaining horizon loads', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zlayer-discovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { read, calls } = source(); let clock = now;
  const cache = new WeatherCache({ directory, maxBytes: 4 * 1024 * 1024, now: () => clock,
    load: async resource => {
      const path = new URL(resource.url).pathname.replace('/high-resolution-rapid-refresh/', 'hrrr/prod/');
      const payload = await read(path, signal);
      clock += 100;
      return { ...payload, checkedAt: clock };
    } });
  const processing = createProcessing(cache, signal, () => clock);
  t.after(() => processing.close()); await cache.restore();
  const index = modelPath('clouds', latest, 18) + '.idx';
  const seed = await cache.get(modelResource(index));
  clock += 59_000;
  const response = await processing.catalog('clouds');
  assert.ok(clock - seed.checkedAt >= 60_000, 'the original index expires during assembly');
  assert.equal(response.status, 200);
  assert.ok(isNativeManifest(JSON.parse(response.body.toString())));
  assert.equal(response.checkedAt, seed.checkedAt + 59_100);
  assert.equal(calls.filter(path => path === index).length, 2, 'aging source metadata is rechecked before assembly');
});

test('native catalogs require complete source horizons', async () => {
  const { read } = source();
  for (const product of ['clouds', 'icing', 'winds'] as const) {
    const manifest = await discover(read, product, signal, now);
    assert.ok(isNativeManifest(JSON.parse(JSON.stringify(manifest))));
    assert.equal(isNativeManifest({ ...manifest, frames: manifest.frames.slice(1) }), false);
    assert.equal(isNativeManifest({ ...manifest, partial: true, frames: manifest.frames.filter(frame => frame.validTime === manifest.runTime + hour) }), false);
  }
});

test('forecast selections reject mixed families and browser/server artifact paths stay identical', async () => {
  const { read } = source();
  for (const product of ['clouds', 'icing', 'winds'] as const) {
    const manifest = await discover(read, product, signal, now), frame = manifest.frames[0]!;
    const before = JSON.stringify(frame);
    assert.equal(selectForecast(manifest, frame).kind, 'native');
    const browser = await preparedSource('https://app.test/api/weather/grids/', manifest, frame);
    assert.equal(new URL(browser.url).pathname, forecastResource(manifest, frame).key);
    assert.equal(JSON.stringify(frame), before, 'selection tags never enter serialized source/cache identity');
    assert.throws(() => selectForecast(manifest, { ...frame, records: {} }), /Incomplete/);
    const archived: AwcGridFrame = { validTime: frame.validTime, altitudeFtMsl: frame.altitudeFtMsl,
      path: 'old.gz', bytes: 1, decodedBytes: 1, sha256: 'a'.repeat(64), sources: frame.sources };
    assert.throws(() => selectForecast(manifest, archived), /Mismatched/);
    const archive: AwcGridManifest = { ...manifest, frames: [archived] };
    Reflect.deleteProperty(archive, 'encoding');
    assert.throws(() => selectForecast(archive, frame), /Mismatched/);
  }
});
