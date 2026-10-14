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
import type { ModelVersion } from '../src/layers/weather-awc/grids/source-version';

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
