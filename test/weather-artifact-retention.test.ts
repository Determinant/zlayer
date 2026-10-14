import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProgsCoverageCatalog, SurfaceCatalog } from '@zlayer/contracts';
import { createInfoServer } from '../tools/info-server/server';
import { WeatherCache } from '../tools/info-server/cache';
import { resourceFor } from '../tools/info-server/weather-resources';
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

test('replaced chart and coverage files keep their grace across repeated server restarts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zlayer-publication-grace-'));
  let now = WEATHER_NOW, version = 0, reads = 0;
  const images = [coveragePng(), coveragePng(1)];
  const options = { directory, startUpdates: false, spacing: 0, now: () => now,
    fetch: async (input: string | URL | Request) => {
      reads++; const path = new URL(String(input)).pathname;
      if (path.endsWith('/progchart')) return Response.json(surfaceCatalog());
      if (path.endsWith('.geojson')) {
        const chart = surfaceChart(path.split('/').pop()!);
        if (version) chart.features[2]!.properties.text = '1027';
        return Response.json(chart);
      }
      return new Response(images[version], { headers: { 'content-type': 'image/png' } });
    } };
  let app = await createInfoServer(options);
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const refresh = async () => { app.progs.refresh(); app.coverage.refresh(); await Promise.all([app.progs.close(), app.coverage.close()]); };
  const catalogs = ['analysis', 'forecast', 'coverage'].map(product => resourceFor(`/api/weather/progs/${product}.json`));
  const files = async () => Promise.all(catalogs.map(async resource => {
    const catalog = JSON.parse((await app.cache.read(resource))!.body.toString()) as SurfaceCatalog | ProgsCoverageCatalog;
    return resourceFor(`/api/weather/progs/${'path' in catalog.frames[0]! ? catalog.frames[0].path : catalog.frames[0]!.file!.path}`);
  }));
  await refresh();
  const previous = await files(), originals = await Promise.all(previous.map(resource => app.cache.read(resource)));
  now += 15 * 60_000; version = 1; await refresh();
  const current = await files(), publishedAt = now;
  assert.ok(current.every((resource, index) => resource.key !== previous[index]!.key));
  for (const elapsed of [1, 9 * 60_000, 10 * 60_000]) {
    await app.close(); now = publishedAt + elapsed;
    const calls = reads; app = await createInfoServer(options);
    assert.equal(reads, calls, 'restart does not acquire sources');
    assert.equal(app.progs.status.analysis!.ready && app.progs.status.forecast!.ready && app.coverage.status.ready, true);
    for (const [index, resource] of previous.entries()) {
      assert.deepEqual(await app.cache.read(resource), elapsed < 10 * 60_000 ? originals[index] : undefined,
        'restart preserves bytes and source timestamps without extending the release deadline');
    }
    assert.ok(current.every(resource => app.cache.has(resource)));
  }
});

for (const bound of ['entries', 'bytes']) test(`startup restores all owners before enforcing a reduced ${bound} limit`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zlayer-startup-pressure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = WEATHER_NOW;
  const body = Buffer.from('artifact'), payload = () => ({ body, checkedAt: now, sha256: digest(body), status: 200, headers: {} });
  const options = { directory, maxBytes: 1024, maxEntries: 10, now: () => now, load: async () => assert.fail('No acquisition') };
  let cache = new WeatherCache(options); await cache.restore();
  const [current, ...orphans] = ['a', 'b', 'c'].map(hash => resourceFor(`/api/weather/progs/analysis/${hash.repeat(64)}.json`));
  cache.retain([current!.key], 'late-owner');
  for (const resource of [current!, ...orphans]) { await cache.put(resource, payload()); now++; }
  const limits = bound === 'entries' ? { maxEntries: 2 } : { maxBytes: body.length * 2 };
  cache = new WeatherCache({ ...options, ...limits }); await cache.restore({ deferPruning: true });
  const repaired = resourceFor('/api/weather/radar/latest.json');
  cache.retain([repaired.key], 'early-owner');
  await cache.put(repaired, payload());
  assert.ok(cache.has(current!), 'another owner’s startup repair cannot evict the current artifact');
  cache.retain([current!.key], 'late-owner'); await cache.prune();
  assert.ok(cache.has(current!) && cache.has(repaired));
  assert.equal(cache.stats.entries, 2);
  assert.ok(orphans.every(resource => !cache.has(resource)));
  cache = new WeatherCache({ ...options, maxEntries: 1 }); await cache.restore({ deferPruning: true });
  cache.retain([current!.key, repaired.key]);
  await assert.rejects(cache.prune(), { status: 507 });
  assert.ok(cache.has(current!) && cache.has(repaired), 'an undersized limit fails without destroying protected publications');
});

test('durable grace shares publication ordering, survives pressure, and leaves source ages unchanged', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zlayer-durable-grace-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = WEATHER_NOW;
  const body = Buffer.from('artifact'), payload = () => ({ body, checkedAt: now, sha256: digest(body), status: 200, headers: {} });
  const products = [
    { catalog: 'grids/clouds.json', artifact: `grids/clouds/${now}-0-0-${'a'.repeat(64)}.zwp.gz`, minutes: 6 },
    { catalog: 'progs/analysis.json', artifact: `progs/analysis/${'a'.repeat(64)}.json`, minutes: 10 },
    { catalog: 'progs/coverage.json', artifact: `progs/coverage/${'a'.repeat(64)}.png`, minutes: 10 },
    { catalog: 'radar/latest.json', artifact: `radar/CONUS/${now}-${'a'.repeat(64)}.json`, minutes: 6 },
    { catalog: 'radar/motion/latest.json', artifact: `radar/motion/${'a'.repeat(64)}.json`, minutes: 6 },
  ].map(p => ({ ...p, catalog: resourceFor(`/api/weather/${p.catalog}`), artifact: resourceFor(`/api/weather/${p.artifact}`) }));
  const options = { directory, maxBytes: 1024, maxEntries: products.length * 2, now: () => now, load: async () => assert.fail('No acquisition') };
  let cache = new WeatherCache(options); await cache.restore();
  cache.retain(products.flatMap(p => [p.catalog.key, p.artifact.key]));
  const original = payload();
  for (const { artifact } of products) await cache.put(artifact, original);
  now += 2 * 3600_000;
  const publishedAt = now;
  await Promise.all(products.map(({ catalog, artifact, minutes }) => cache.put(catalog, payload(),
    { resources: [artifact], milliseconds: minutes * 60_000 })));
  const restart = async () => {
    cache = new WeatherCache(options); await cache.restore({ deferPruning: true });
    cache.retain(products.map(p => p.catalog.key)); await cache.prune();
  };
  await restart();
  const query = resourceFor('/api/weather/metars.geojson?ids=KSFO');
  await assert.rejects(cache.put(query, payload()), { status: 507 });
  assert.ok(products.every(p => cache.has(p.artifact)), 'capacity pressure cannot remove a promised artifact');
  for (const minutes of [5, 6, 9, 10]) {
    now = publishedAt + minutes * 60_000; await restart();
    for (const product of products) assert.deepEqual(await cache.read(product.artifact), minutes < product.minutes ? original : undefined);
  }
});

test('failed durable protection leaves the preceding catalog committed and retries safely', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zlayer-grace-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = WEATHER_NOW;
  const body = Buffer.from('catalog'), payload = () => ({ body, checkedAt: now, sha256: digest(body), status: 200, headers: {} });
  const cache = new WeatherCache({ directory, maxBytes: 1024, now: () => now, load: async () => assert.fail('No acquisition') });
  await cache.restore();
  const catalog = resourceFor('/api/weather/progs/analysis.json');
  const artifact = resourceFor(`/api/weather/progs/analysis/${'a'.repeat(64)}.json`);
  cache.retain([catalog.key, artifact.key]);
  const original = payload(); await cache.put(artifact, original); await cache.put(catalog, original);
  now += 15 * 60_000;
  const path = join(directory, 'retention.json'); await mkdir(path);
  await assert.rejects(cache.put(catalog, payload(), { resources: [artifact], milliseconds: 600_000 }));
  assert.deepEqual(await cache.read(catalog), original);
  await rm(path, { recursive: true });
  await cache.put(catalog, payload(), { resources: [artifact], milliseconds: 600_000 });
  assert.equal((await cache.read(catalog))!.checkedAt, now);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).leases, [[artifact.key, now + 600_000]]);
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

test('restored artifacts adopt product retention after every owner restores its protected references', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zlayer-product-retention-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = WEATHER_NOW;
  const body = Buffer.from('saved'), payload = { body, checkedAt: now, sha256: digest(body), status: 200, headers: {} };
  const options = { directory, maxBytes: 1024 * 1024, now: () => now, load: async () => assert.fail('No acquisition') };
  let cache = new WeatherCache(options); await cache.restore();
  const products = [
    { path: `radar/CONUS/${WEATHER_NOW}-${'a'.repeat(64)}.json`, minutes: 6 },
    { path: `radar/motion/${'a'.repeat(64)}.json`, minutes: 6 },
    { path: `progs/analysis/${'a'.repeat(64)}.json`, minutes: 10 },
    { path: `progs/coverage/${'a'.repeat(64)}.png`, minutes: 10 },
    { path: `grids/clouds/${WEATHER_NOW}-0-0-${'a'.repeat(64)}.zwp.gz`, minutes: 60 },
  ].map(({ path, minutes }) => ({ minutes, current: resourceFor(`/api/weather/${path}`),
    orphan: resourceFor(`/api/weather/${path.replace('a'.repeat(64), 'b'.repeat(64))}`) }));
  for (const { current, orphan } of products) for (const resource of [current, orphan]) {
    await cache.put({ ...resource, ttl: 86400_000 }, payload); // Metadata from the former common retention policy.
  }
  now += 6 * 60_000;
  cache = new WeatherCache(options); await cache.restore({ deferPruning: true });
  const catalog = resourceFor('/api/weather/grids/clouds.json');
  await cache.put(catalog, { ...payload, checkedAt: now });
  assert.ok(products.every(p => cache.storedSize(p.current) && cache.storedSize(p.orphan)),
    'an early owner publication during startup cannot sweep another owner’s references');
  cache.retain(products.map(p => p.current.key));
  for (const minutes of [6, 10, 60]) {
    now = WEATHER_NOW + minutes * 60_000; await cache.prune();
    for (const product of products) {
      assert.deepEqual(await cache.read(product.current), payload, 'protected bytes and original timestamps remain available');
      assert.equal(cache.storedSize(product.orphan) > 0, minutes < product.minutes, 'released files use their product retention age');
    }
  }
  const stats = cache.stats;
  assert.equal(stats.expiredRemovals, products.length);
  assert.equal(Object.values(stats.products).reduce((n, p) => n + p.entries, 0), stats.entries);
  assert.equal(Object.values(stats.products).reduce((n, p) => n + p.bytes, 0), stats.bytes);
  assert.equal(Object.values(stats.products).reduce((n, p) => n + p.expiredRemovals, 0), stats.expiredRemovals);
});
