import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProgsCoverageCatalog, SurfaceCatalog } from '@zlayer/contracts';
import { createInfoServer } from '../tools/info-server/server';
import { WeatherCache } from '../tools/info-server/cache';
import { resourceFor } from '../tools/info-server/routes';
import { digest } from '../tools/info-server/upstream';
import { coveragePng } from './fixtures/progs-coverage';
import { surfaceCatalog, surfaceChart } from './fixtures/wpc';
import { WEATHER_NOW } from './fixtures/awc-advisories';

test('refreshed chart and coverage catalogs keep original immutable files readable beyond 24 hours and restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zlayer-artifact-retention-'));
  let now = WEATHER_NOW, reads = 0;
  const png = coveragePng(), options = { directory, startUpdates: false, spacing: 0, now: () => now,
    fetch: async (input: string | URL | Request) => {
      reads++; const path = new URL(String(input)).pathname;
      if (path.endsWith('/progchart')) return Response.json(surfaceCatalog());
      if (path.endsWith('.geojson')) return Response.json(surfaceChart(path.split('/').pop()!));
      return new Response(png, { headers: { 'content-type': 'image/png' } });
    } };
  let app = await createInfoServer(options);
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const refresh = async () => { app.progs.refresh(); app.coverage.refresh(); await Promise.all([app.progs.close(), app.coverage.close()]); };
  const catalogs = ['analysis', 'forecast', 'coverage'].map(product => resourceFor(`/api/weather/progs/${product}.json`));
  await refresh();
  const originals = await Promise.all(catalogs.map(async resource => {
    const saved = await app.cache.read(resource); assert.ok(saved);
    const catalog = JSON.parse(saved.body.toString()) as SurfaceCatalog | ProgsCoverageCatalog;
    const paths = catalog.frames.map(frame => 'path' in frame ? frame.path : frame.file!.path);
    return Promise.all(paths.map(async path => {
      const resource = resourceFor(`/api/weather/progs/${path}`), payload = await app.cache.read(resource);
      assert.ok(payload); return { resource, payload };
    }));
  }));
  now += 24 * 3600_000 - 60_000; await refresh(); now += 61_000;
  const catalogTimes = await Promise.all(catalogs.map(async resource => (await app.cache.read(resource))!.checkedAt));
  assert.ok(catalogTimes.every(time => now - time === 61_000));
  for (let restart = 0; restart < 2; restart++) {
    assert.equal(app.progs.status.analysis!.ready, true); assert.equal(app.progs.status.forecast!.ready, true);
    assert.equal(app.coverage.status.ready, true);
    for (const { resource, payload } of originals.flat()) assert.deepEqual(await app.cache.read(resource), payload, 'retention preserves bytes and original check time');
    if (!restart) {
      const before = reads; await app.close(); app = await createInfoServer(options);
      assert.equal(reads, before, 'startup restores referenced old files without acquiring sources');
    }
  }
});

test('immutable retention never freshens catalogs or queries, and released files are reclaimed below capacity', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zlayer-immutable-cache-')); t.after(() => rm(directory, { recursive: true, force: true }));
  let now = WEATHER_NOW;
  const body = Buffer.from('saved'), payload = { body, checkedAt: now, sha256: digest(body), status: 200, headers: {} };
  const options = { directory, maxBytes: 1024, now: () => now, load: async () => { throw new Error('No acquisition'); } };
  let cache = new WeatherCache(options); await cache.restore();
  const artifacts = [`grids/clouds/${WEATHER_NOW}-0-0-${'a'.repeat(64)}.zwp.gz`, `progs/coverage/${'b'.repeat(64)}.png`].map(path => resourceFor(`/api/weather/${path}`));
  const catalog = resourceFor('/api/weather/grids/clouds.json'), query = resourceFor('/api/weather/metars.geojson?ids=KSFO');
  for (const resource of [...artifacts, catalog, query]) await cache.put(resource, payload);
  cache.retain([...artifacts, catalog, query].map(r => r.key)); now += 24 * 3600_000;
  assert.equal(await cache.read(catalog), undefined); assert.equal(await cache.read(query), undefined);
  assert.ok(artifacts.every(resource => cache.has(resource)));
  cache = new WeatherCache(options); await cache.restore();
  cache.retain([artifacts[0]!.key]); await cache.prune();
  assert.deepEqual(await cache.read(artifacts[0]!), payload);
  assert.equal(cache.storedSize(artifacts[1]!), 0, 'unreferenced old artifacts are swept after restoration');
  cache.retain([]); now += 60_000; await cache.prune();
  assert.equal(cache.stats.entries, 0);
});
