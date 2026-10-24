import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUpstream, digest } from '../tools/info-server/upstream';
import { InvalidForecastSourceError, modelMetadataResource, modelResource } from '../tools/info-server/weather-resources';
import { sourceBlocks, sourceRecordKey } from '../tools/info-server/source-records';
import { WeatherCache } from '../tools/info-server/cache';
import { createProcessing } from '../tools/info-server/processing';
import { nativeForecastFiles } from './fixtures/awc-native.mjs';
import { isModelVersion, modelVersionKey, type ModelVersion } from '../src/layers/weather-awc/grids/source-version';

const path = 'dafs/prod/dafs.20260922/dafs.t20z.ifi.3km.conus.f001.grib2';
const now = Date.UTC(2026, 8, 22, 21), signal = new AbortController().signal;
const lastModified = new Date(now - 10 * 60_000).toUTCString();
const grib = Buffer.alloc(32);
grib.write('GRIB'); grib[7] = 2; grib.writeBigUInt64BE(32n, 8); grib.write('7777', 28);

for (const validator of [{ etag: '"version-1"' }, { lastModified }] as const) {
  test(`model object ${'etag' in validator ? 'ETag' : 'modification time'} pins discovery and conditional ranges`, async () => {
    const version = { byteLength: 132_000_000, ...validator };
    const sourceHeaders = 'etag' in validator ? { etag: validator.etag } : { 'last-modified': validator.lastModified };
    let responseVersion: Record<string, string> = sourceHeaders;
    let total = version.byteLength, status = 206;
    const load = createUpstream({ signal, spacing: 0, now: () => now, fetch: async (_url, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('cache-control'), 'no-cache');
      if (init?.method === 'HEAD') return new Response(null, { headers: { ...sourceHeaders, 'content-length': String(version.byteLength) } });
      assert.equal(headers.get('range'), 'bytes=0-31');
      assert.equal(headers.get('etag' in validator ? 'if-match' : 'if-unmodified-since'), 'etag' in validator ? validator.etag : validator.lastModified);
      return new Response(status === 206 ? grib : null, { status,
        headers: { ...responseVersion, 'content-range': `bytes 0-31/${total}` } });
    } });
    const metadata = await load(modelMetadataResource(path));
    assert.deepEqual(JSON.parse(metadata.body.toString()), version, 'HEAD does not apply a range/body limit to the whole object length');
    const range = modelResource(path, 'bytes=0-31', 'a'.repeat(64), version);
    assert.deepEqual((await load(range)).body, grib);
    total++; await assert.rejects(load(range), { status: 409 }); total--;
    responseVersion = {}; await assert.rejects(load(range), { status: 409 });
    status = 412; await assert.rejects(load(range), { status: 409 });
  });
}

test('metadata requires a usable validator and range batching separates object versions', async () => {
  for (const headers of [{}, { etag: 'W/"weak"' }, { 'last-modified': 'invalid' }, { 'last-modified': new Date(now).toUTCString() }]) {
    const load = createUpstream({ signal, spacing: 0, now: () => now,
      fetch: async () => new Response(null, { headers: { 'content-length': '64', ...headers } }) });
    await assert.rejects(load(modelMetadataResource(path)), /object version|too recent/);
  }
  const version: ModelVersion = { byteLength: 64, etag: '"original"' };
  const first = { path, start: 0, end: 31, indexHash: 'a'.repeat(64), version };
  const next = { ...first, start: 32, end: 63, version: { ...version, etag: '"corrected"' } };
  const plan = sourceBlocks([first, next]);
  assert.notEqual(plan.get(sourceRecordKey(first)), plan.get(sourceRecordKey(next)));
  assert.notEqual(modelResource(path, 'bytes=0-31', first.indexHash, version).key,
    modelResource(path, 'bytes=0-31', first.indexHash, next.version).key);
});

test('mirror identity is bounded, separates raw blocks, and preserves existing identities', () => {
  const version: ModelVersion = { byteLength: 64, etag: '"same-validator"' };
  const mirror: ModelVersion = { ...version, mirror: 'noaa-hrrr-s3' };
  assert.equal(modelVersionKey(version), JSON.stringify([64, version.etag, null]));
  assert.notEqual(modelVersionKey(version), modelVersionKey(mirror));
  assert.ok(isModelVersion(mirror));
  for (const bad of ['unknown', 'https://other.test', null, 1]) assert.equal(isModelVersion({ ...version, mirror: bad }), false);
  assert.throws(() => modelResource(path, 'bytes=0-31', 'a'.repeat(64), mirror), /Invalid model mirror/);
  const hrrr = 'hrrr/prod/hrrr.20260922/conus/hrrr.t20z.wrfprsf01.grib2';
  const first = { path: hrrr, start: 0, end: 31, indexHash: 'a'.repeat(64), version };
  const second = { ...first, start: 32, end: 63, version: mirror };
  const plan = sourceBlocks([first, second]);
  assert.notEqual(plan.get(sourceRecordKey(first)), plan.get(sourceRecordKey(second)));
  assert.equal(new URL(plan.get(sourceRecordKey(second))!.resource.url).host, 'noaa-hrrr-bdp-pds.s3.amazonaws.com');
});

for (const product of ['clouds', 'icing'] as const) test(`${product} mirror recovery pins its index and conditional ranges through conversion and raw-cache restart`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zlayer-hrrr-mirror-')), shutdown = new AbortController();
  const files = nativeForecastFiles(); let requests = 0, mirrorRanges = 0, ifiRanges = 0;
  const load = createUpstream({ signal: shutdown.signal, spacing: 0, now: () => now, fetch: async (url, init) => {
    requests++;
    const parsed = new URL(String(url)), mirror = parsed.host === 'noaa-hrrr-bdp-pds.s3.amazonaws.com';
    const ifi = parsed.host === 'nomads.ncep.noaa.gov';
    const sourcePath = ifi ? '/weather/noaa/' + parsed.pathname.replace('/pub/data/nccf/com/', '')
      : '/weather/noaa/hrrr/prod/' + parsed.pathname.replace(/^\/(?:high-resolution-rapid-refresh\/)?/, '');
    let raw = files.get(sourcePath); assert.ok(raw, sourcePath);
    const etag = `"${mirror ? 'mirror-' : ''}${digest(raw)}"`;
    if (init?.method === 'HEAD') return new Response(null, { headers: { etag,
      'content-length': String(!mirror && sourcePath.endsWith(product === 'clouds' ? 'wrfsfcf04.grib2' : 'wrfsfcf00.grib2') ? 1 : raw.length) } });
    if (sourcePath.endsWith('.idx')) return new Response(mirror ? raw.toString().replaceAll('\n', '\r\n') : Uint8Array.from(raw));
    assert.ok(mirror || ifi, 'recovered conversion must not return to the damaged HRRR primary');
    if (ifi) ifiRanges++; else mirrorRanges++;
    const headers = new Headers(init?.headers), range = /^bytes=(\d+)-(\d*)$/.exec(headers.get('range')!)!;
    assert.equal(headers.get('if-match'), etag);
    const start = Number(range[1]), end = range[2] ? Number(range[2]) : raw.length - 1;
    return new Response(Uint8Array.from(raw.subarray(start, end + 1)), { status: 206,
      headers: { etag, 'content-range': `bytes ${start}-${end}/${raw.length}`, 'content-length': String(end - start + 1) } });
  } });
  const options = { directory, maxBytes: 32 * 1024 * 1024, now: () => now, signal: shutdown.signal, load };
  const cache = new WeatherCache(options); await cache.restore();
  const processing = createProcessing(cache, shutdown.signal, () => now);
  t.after(async () => { shutdown.abort(); await processing.close(); await cache.drain(); await rm(directory, { recursive: true, force: true }); });
  const manifest = JSON.parse((await processing.catalog(product)).body.toString());
  assert.ok(manifest.frames.every((frame: any) => Object.entries(frame.records).every(([field, record]: [string, any]) =>
    product === 'clouds' || field === 'terrain' ? record.version.mirror === 'noaa-hrrr-s3' : record.version.mirror === undefined)));
  const frame = manifest.frames[4], converted = await processing.forecast(manifest, frame);
  assert.ok(converted.body.length > 0); assert.ok(mirrorRanges > 0);
  assert.equal(ifiRanges > 0, product === 'icing');
  const records = Object.values(frame.records) as import('../src/layers/weather-awc/grids/native-source').SourceRecord[];
  const resource = sourceBlocks(records).get(sourceRecordKey(records[0]!))!.resource;
  const saved = await cache.read(resource); assert.ok(saved);
  await cache.drain(); const before = requests;
  const restored = new WeatherCache(options); await restored.restore();
  assert.deepEqual((await restored.read(resource))?.body, saved.body);
  assert.equal(requests, before, 'restart reads validated mirror input without acquisition');
});

test('a decoder-rejected cached GRIB is quarantined and the same selection recovers after backoff', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zlayer-rejected-grib-'));
  const files = nativeForecastFiles(), shutdown = new AbortController();
  let time = now, invalid = true, downloads = 0;
  const rawResources = new Set<string>();
  const cache = new WeatherCache({ directory, maxBytes: 64 * 1024 * 1024, now: () => time,
    load: async resource => {
      const sourcePath = '/weather/noaa/hrrr/prod/' + new URL(resource.url).pathname.replace('/high-resolution-rapid-refresh/', '');
      const raw = files.get(sourcePath)!;
      assert.ok(raw, sourcePath);
      let body = resource.kind === 'model-metadata'
        ? Buffer.from(JSON.stringify({ byteLength: raw.length, etag: `"${digest(raw)}"` })) : Buffer.from(raw);
      if (resource.kind === 'range') {
        downloads++; rawResources.add(resource.key);
        const range = /^bytes=(\d+)-(\d*)$/.exec(resource.range!)!;
        body = Buffer.from(raw.subarray(Number(range[1]), range[2] ? Number(range[2]) + 1 : undefined));
        if (invalid) {
          // Keep envelope, offsets and bytes intact; reject the first record's
          // unsupported packing only after it has entered the source cache.
          for (let offset = 16; offset < body.length - 4; offset += body.readUInt32BE(offset)) {
            if (body[offset + 4] === 5) { body.writeUInt16BE(40, offset + 9); break; }
          }
        }
      }
      return { body, checkedAt: time, sha256: digest(body), status: 200, headers: {} };
    } });
  await cache.restore();
  const processing = createProcessing(cache, shutdown.signal, () => time);
  t.after(async () => { shutdown.abort(); await processing.close(); await cache.drain(); await rm(directory, { recursive: true, force: true }); });
  const manifest = JSON.parse((await processing.catalog('clouds')).body.toString());
  await assert.rejects(processing.forecast(manifest, manifest.frames[0]), error => error instanceof InvalidForecastSourceError && /packing/.test(error.message));
  const failedDownloads = downloads;
  await assert.rejects(processing.forecast(manifest, manifest.frames[0]), InvalidForecastSourceError);
  assert.equal(downloads, failedDownloads, 'shared source backoff prevents a retry storm');
  invalid = false; time += 6000;
  const recovered = await processing.forecast(manifest, manifest.frames[0]);
  assert.ok(recovered.body.length > 0);
  assert.equal(downloads, failedDownloads + 1, 'the failed block is fetched again rather than reused for 24 hours');
  assert.equal(rawResources.size, 1, 'recovery uses the same indexed source identity');
});
