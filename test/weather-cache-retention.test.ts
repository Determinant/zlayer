import assert from 'node:assert/strict';
import test from 'node:test';
import type { AwcGridManifest, AwcGridProduct } from '@zlayer/contracts';
import { GridClient } from '../src/layers/weather-awc/grids/client';
import { forecastRetention } from '../src/layers/weather-awc/grids/retention';
import { windFrames } from '../src/layers/weather-awc/grids/wind-levels';
import { pluginStorage } from '../src/layers/weather-awc/storage';
import type { NativeManifest } from '../src/layers/weather-awc/grids/native-source';
import { gridFixture } from './fixtures/awc-grids';
import { cacheFixture } from './helpers/cache';

function horizon(product: AwcGridProduct, altitudes = [8000]) {
  const fixture = gridFixture(product), manifest: AwcGridManifest = { ...fixture.manifest, frames: [] };
  const template = fixture.manifest.frames.find(f => product === 'clouds' || f.altitudeFtMsl === 8000)!;
  const body = Buffer.from(fixture.files[template.path]!, 'base64');
  for (const altitude of product === 'clouds' ? [null] : altitudes) for (let lead = product === 'icing' ? 1 : 0; lead <= 18; lead++) {
    manifest.frames.push({ ...template, validTime: manifest.runTime + lead * 3600000, altitudeFtMsl: altitude,
      path: `runs/${manifest.generation}/${lead}-${altitude}.zwg.gz` });
  }
  return { manifest, body };
}

test('complete icing altitudes replace only older icing selections while clouds and the selected altitude stay offline', async t => {
  cacheFixture(t);
  const clouds = horizon('clouds'), icing = horizon('icing', [8000, 12000, 15000]);
  const fetch = t.mock.method(globalThis, 'fetch', async (url: string) => new Response(url.includes('clouds') ? clouds.body : icing.body));
  const client = new GridClient('https://test/');
  const signal = new AbortController().signal;
  for (const frame of clouds.manifest.frames) assert.equal(client.saved(await client.load(clouds.manifest, frame, signal, true)), true);
  for (const altitude of [8000, 12000, 15000]) {
    const frames = icing.manifest.frames.filter(f => f.altitudeFtMsl === altitude);
    // Alternating hours exercise retention independently of access/time order.
    for (const frame of [...frames.filter((_, i) => i % 2), ...frames.filter((_, i) => !(i % 2))]) {
      assert.equal(client.saved(await client.load(icing.manifest, frame, signal, true)), true);
    }
    assert.deepEqual(await client.checkSaved(icing.manifest, frames, signal), frames.map(() => true));
    assert.deepEqual(await client.checkSaved(clouds.manifest, clouds.manifest.frames, signal), clouds.manifest.frames.map(() => true));
  }
  assert.deepEqual(await client.checkSaved(icing.manifest, icing.manifest.frames.filter(f => f.altitudeFtMsl === 8000), signal), Array(18).fill(false));
  // Enough disposable pressure inputs to exceed both their namespace and default pool.
  const inputs = pluginStorage.files('pressure-levels', { maxEntries: 64, maxBytes: 256 * 1024 * 1024, maxFileBytes: 16 * 1024 * 1024, maxUnusedMs: 48 * 3600000 });
  for (let i = 0; i < 100; i++) await inputs.derive({ url: `https://test/input-${i}`, identity: 'v1', signal, label: 'Input',
    create: async () => new Uint8Array([1, 2]).buffer, validate: async () => true });
  const acquired = fetch.mock.callCount(), reopened = new GridClient('https://test/');
  for (const frame of icing.manifest.frames.filter(f => f.altitudeFtMsl === 15000)) {
    assert.equal(reopened.saved(await reopened.load(icing.manifest, frame, signal, false)), true);
  }
  for (const frame of clouds.manifest.frames) assert.equal(reopened.saved(await reopened.load(clouds.manifest, frame, signal, false)), true);
  assert.equal(fetch.mock.callCount(), acquired, 'complete retained timelines reopen without downloading');
});

test('wind retention spans forecast hours but separates altitude, endpoint and same-run source corrections', async () => {
  const manifest = gridFixture('winds').manifest, frames = windFrames(manifest, 5000), endpoint = 'https://test/';
  const first = await forecastRetention(endpoint, manifest, frames[0]!);
  assert.deepEqual(await forecastRetention(endpoint, manifest, frames[1]!), first);
  assert.notDeepEqual(await forecastRetention(endpoint, manifest, windFrames(manifest, 5500)[0]!), first);
  assert.notDeepEqual(await forecastRetention('https://other.test/', manifest, frames[0]!), first);
  const corrected = { ...manifest, frames: manifest.frames.map((f, i) => i === 0 ? { ...f, sha256: '1'.repeat(64) } : f) };
  assert.notDeepEqual(await forecastRetention(endpoint, corrected, windFrames(corrected, 5000)[0]!), first);
  const reordered = { ...manifest, frames: [...manifest.frames].reverse() };
  assert.deepEqual(await forecastRetention(endpoint, reordered, windFrames(reordered, 5000)[0]!), first);
});

test('a corrected icing hour replaces obsolete bytes without evicting unchanged hours of the selected altitude', async t => {
  cacheFixture(t);
  const { manifest, body } = horizon('icing');
  t.mock.method(globalThis, 'fetch', async () => new Response(body));
  const client = new GridClient('https://test/'), signal = new AbortController().signal;
  for (const frame of manifest.frames) await client.load(manifest, frame, signal, true);
  const corrected = { ...manifest, frames: manifest.frames.map((frame, i) => i === 17 ? { ...frame, path: `${frame.path}.corrected` } : frame) };
  // The obsolete hour was used most recently; ordinary LRU would delete the
  // first unchanged hour before reaching it in the old cohort.
  assert.equal(client.saved(await client.load(corrected, corrected.frames[17]!, signal, true)), true);
  assert.deepEqual(await client.checkSaved(corrected, corrected.frames, signal), Array(18).fill(true));
  assert.deepEqual(await client.checkSaved(manifest, [manifest.frames[17]!], signal), [false]);
});

test('native catalog freshness checks preserve a cohort while a corrected source changes it', async () => {
  const source = gridFixture('clouds').manifest;
  const manifest: NativeManifest = { ...source, encoding: 'grib2', frames: source.frames.map(frame => ({
    validTime: frame.validTime, altitudeFtMsl: null, sources: frame.sources,
    records: { cloudCover: { path: frame.path, start: 0, end: 100, indexHash: frame.sha256 } },
  })) };
  const first = await forecastRetention('https://test/', manifest, manifest.frames[0]!);
  const checked = { ...manifest, checkedAt: manifest.checkedAt + 60000, publishedAt: manifest.publishedAt + 60000 };
  assert.deepEqual(await forecastRetention('https://test/', checked, checked.frames[1]!), first);
  const corrected = { ...checked, frames: checked.frames.map(frame => ({ ...frame,
    records: { cloudCover: { ...frame.records.cloudCover!, indexHash: '1'.repeat(64) } },
  })) };
  assert.notDeepEqual(await forecastRetention('https://test/', corrected, corrected.frames[0]!), first);
});
