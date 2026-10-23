import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AwcGridProduct, AwcGridFrame, AwcGridManifest } from '@zlayer/contracts';
import { discover, type ReadSource } from '../tools/info-server/discovery';
import { HttpError, InvalidForecastIndexError, modelResource } from '../tools/info-server/weather-resources';
import { WeatherCache } from '../tools/info-server/cache';
import { createProcessing } from '../tools/info-server/processing';
import { digest, type Payload } from '../tools/info-server/upstream';
import { isNativeManifest, modelPath } from '../src/layers/weather-awc/grids/native-source';
import { nativeForecastFiles } from './fixtures/awc-native.mjs';
import { selectForecast } from '../src/layers/weather-awc/grids/selection';
import { preparedSource } from '../src/layers/weather-awc/grids/prepared-client';
import { forecastResource } from '../tools/info-server/processing';
import type { ModelMirror } from '../src/layers/weather-awc/grids/source-version';
import truncated from './fixtures/hrrr-truncated-2026-10-21/provenance.json' with { type: 'json' };

const hour = 3600000, older = Date.UTC(2026, 8, 22, 20), latest = older + hour, now = latest + hour;
const signal = new AbortController().signal, files = nativeForecastFiles();
function source(change: (path: string, body: string, mirror?: ModelMirror) => string = (_path, body) => body) {
  const entries = new Map<string, Payload>(), calls: string[] = [];
  for (const run of [older, latest]) for (const product of ['clouds', 'winds', 'icing'] as const) {
    for (let lead = product === 'icing' ? 1 : 0; lead <= 18; lead++) {
      const template = files.get('/weather/noaa/' + modelPath(product, older, lead) + '.idx')!;
      const body = Buffer.from(template.toString().replaceAll('d=2026092220', run === latest ? 'd=2026092221' : 'd=2026092220'));
      entries.set(modelPath(product, run, lead) + '.idx', { body, status: 200, headers: {}, sha256: digest(body),
        checkedAt: now - (run === latest ? 55_000 : 1000) });
      const raw = files.get('/weather/noaa/' + modelPath(product, older, lead))!;
      const metadata = Buffer.from(JSON.stringify({ byteLength: raw.length, etag: `"${digest(raw)}"` }));
      entries.set(modelPath(product, run, lead), { body: metadata, status: 200, headers: {}, sha256: digest(metadata),
        checkedAt: now - (run === latest ? 55_000 : 1000) });
    }
  }
  const read: ReadSource = async (path, signal, mirror) => {
    signal.throwIfAborted(); calls.push(path);
    const entry = entries.get(path);
    if (!entry) throw new HttpError(404, 'Missing cycle');
    const body = Buffer.from(change(path, entry.body.toString(), mirror));
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
  assert.equal(absent.calls.length, 12, 'six cycles and at most two HRRR mirrors remain bounded');
});

test('a truncated HRRR object tries one complete alternate mirror before aging the run', async () => {
  for (const product of ['clouds', 'winds'] as const) {
    const broken = modelPath(product, latest, 4);
    const { read, calls } = source((path, body, mirror) => path === broken && !mirror
      ? JSON.stringify({ ...JSON.parse(body), byteLength: 1 }) : body);
    const manifest = await discover(read, product, signal, now);
    assert.equal(manifest.runTime, latest); assert.ok(isNativeManifest(manifest));
    assert.ok(manifest.frames.every(frame => Object.values(frame.records).every(record => record.version?.mirror === 'noaa-hrrr-s3')),
      'the full run and terrain use one qualified mirror, including its indexes and validators');
    assert.ok(calls.every(path => path.includes('t21z')), 'successful mirror recovery never requests an older cycle');
  }
  const failed = source((path, body, mirror) => {
    if (path === modelPath('winds', latest, 4) && !mirror) return JSON.stringify({ ...JSON.parse(body), byteLength: 1 });
    if (mirror) throw new HttpError(503, 'Alternate mirror is backing off', 30);
    return body;
  });
  await assert.rejects(discover(failed.read, 'winds', signal, now), /Alternate mirror is backing off/);
  assert.ok(failed.calls.every(path => path.includes('t21z')), 'alternate backoff cannot amplify older-cycle probes');
});

test('the captured 15Z wind index rejects the truncated Google object and qualifies the NOAA mirror', async () => {
  const capturedIndex = await readFile(new URL('./fixtures/hrrr-truncated-2026-10-21/hrrr.t15z.wrfprsf04.grib2.idx', import.meta.url));
  const mirrorIndex = await readFile(new URL('./fixtures/hrrr-truncated-2026-10-21/hrrr.t15z.wrfprsf04.mirror.grib2.idx', import.meta.url));
  assert.equal(digest(capturedIndex), truncated.indexSha256);
  assert.equal(digest(mirrorIndex), truncated.mirrorIndexSha256);
  assert.notEqual(truncated.indexSha256, truncated.mirrorIndexSha256);
  const run = Date.parse(truncated.runTime), checkedAt = run + 2 * hour;
  const read: ReadSource = async (path, _signal, mirror) => {
    const wind = path.includes('wrfprs'), index = path.endsWith('.idx');
    const metadata = mirror ? truncated.mirror : truncated.google;
    const terrain = files.get('/weather/noaa/' + modelPath('clouds', older, 0))!;
    const body = wind ? index ? (mirror ? mirrorIndex : capturedIndex) : Buffer.from(JSON.stringify({ byteLength: metadata.byteLength, etag: metadata.etag }))
      : index ? Buffer.from(files.get('/weather/noaa/' + modelPath('clouds', older, 0) + '.idx')!.toString().replaceAll('d=2026092220', 'd=2026102115'))
        : Buffer.from(JSON.stringify({ byteLength: terrain.length, etag: '"fixture-terrain"' }));
    return { body, checkedAt, status: 200, headers: {}, sha256: digest(body) };
  };
  await assert.rejects(discover(read, 'winds', signal, checkedAt, { runTime: run, lead: truncated.lead }), /index exceeds its model object/);
  const recovered = await discover(read, 'winds', signal, checkedAt, { runTime: run, lead: truncated.lead, mirror: 'noaa-hrrr-s3' });
  assert.equal(recovered.frames.length, 37);
  assert.ok(recovered.frames.every(frame => Object.values(frame.records).every(record => record.version?.mirror === 'noaa-hrrr-s3')));
  assert.ok(recovered.frames.every(frame => frame.records.windHeight!.indexHash === truncated.mirrorIndexSha256));
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
    const legacy = structuredClone(manifest);
    for (const frame of legacy.frames) for (const record of Object.values(frame.records)) delete record.version;
    assert.ok(isNativeManifest(legacy), 'previously prepared offline catalogs retain their original identity');
    const invalid = structuredClone(manifest);
    Object.values(invalid.frames[0]!.records)[0]!.version = { byteLength: 1, etag: 'W/"weak"' };
    assert.equal(isNativeManifest(invalid), false, 'present object versions cannot bypass validation');
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
