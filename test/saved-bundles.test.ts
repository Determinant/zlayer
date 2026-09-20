import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { type TestContext } from 'node:test';
import type { CatalogResponse } from '@zlayer/contracts';
import { chartRegionPlans } from '../src/layers/charts/offline';
import type { DownloadPlan } from '../src/offline/downloads';

const records = new Map<string, unknown>(), present = new Set<string>();
Object.assign(globalThis, { bundleTestRecords: records, bundleTestFiles: present });
const loader = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.includes('/offline/') && specifier.startsWith('.')) {
    const modules: Record<string, string> = {
      [new URL('../src/core/storage/database', import.meta.url).href]: `export const readOfflineRecord = async key => globalThis.bundleTestRecords.get(key);
        export const writeOfflineRecord = async (key, value) => value === undefined
          ? globalThis.bundleTestRecords.delete(key) : globalThis.bundleTestRecords.set(key, value);
        export const offlineRecords = async prefix => [...globalThis.bundleTestRecords]
          .filter(([key]) => key.startsWith(prefix)).map(([, value]) => value);`,
      [new URL('../src/offline/storage', import.meta.url).href]: `export const cachedFileBytes = async file => globalThis.bundleTestFiles.has(file.url) ? file.byteLength : undefined;`,
      [new URL('../src/offline/reference-readiness', import.meta.url).href]: 'export const regionReferencesReady = async () => true;',
    };
    const fixture = modules[new URL(specifier, context.parentURL).href];
    if (fixture) return { url: 'data:text/javascript,' + encodeURIComponent(fixture), shortCircuit: true };
  }
  return next(specifier, context);
} });
const { restoreSavedBundles, restoreSavedBundleMetadata, checkSavedBundleAvailability, retainFailedBundleOwnership } = await import('../src/offline/bundle-repository');
const { persistBundleSnapshot } = await import('../src/offline/bundle-snapshots');
loader.deregister();

function setup(t: TestContext) {
  records.clear(); present.clear();
  for (const [key, value] of Object.entries({ location: { href: 'https://app.test/' },
    navigator: { locks: { request: async (_name: string, _options: unknown, work: (lock: object) => unknown) => work({}) } },
  })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => original ? Object.defineProperty(globalThis, key, original) : Reflect.deleteProperty(globalThis, key));
  }
}

function catalog(revision = '2026-09-03', generatedAt = `${revision}T00:00:00Z`): CatalogResponse {
  const root = `https://charts.test/${revision}/mbtiles`;
  return { schemaVersion: 1, revision, generatedAt, weather: [],
    charts: [{ id: 'test', title: 'Test', kind: 'vfr-sectional', format: 'mbtiles', revision,
      url: `${root}/test.mbtiles`, bounds: [-125, 32, -114, 42], minZoom: 0, maxZoom: 0,
      byteLength: 100, sha256: 'a'.repeat(64) }],
    navigation: (['airports', 'fixes', 'navaids', 'vfr-waypoints'] as const).map(id => ({
      id, title: id, url: `https://charts.test/${revision}/nav/${id}?v=${generatedAt}`, count: 0, sourceCount: 0, minZoom: 0,
    })),
    airways: { id: 'airways', title: 'Airways', url: `https://charts.test/${revision}/nav/airways?v=${generatedAt}`, count: 0, sourceCount: 0 },
    chartPackages: { root, maximumArchiveBytes: 4194304, regions: [], archives: [{
      id: 'vfr-sectional-z0-r0-0-0', file: `vfr-sectional-z0-r0-0-0-${'a'.repeat(64)}.mbtiles`, kind: 'vfr-sectional', zoom: 0,
      root: { z: 0, x: 0, y: 0 }, bounds: [-180, -85.0511287798066, 180, 85.0511287798066],
      byteLength: 100, sha256: 'a'.repeat(64), tileMask: '1',
    }] },
  };
}
const plan = (catalog: CatalogResponse, regionId = 'us-CA') =>
  chartRegionPlans(catalog, 'https://app.test/').find(({ region }) => region.id === regionId)!.plan;
async function save(value: DownloadPlan, complete = true) {
  const persisted = { ...await persistBundleSnapshot(value), ...(complete ? { completedAt: Date.now() } : {}) };
  records.set(`region:${value.id}`, persisted);
  value.files.forEach(file => present.add(file.url));
  return persisted;
}

test('saved snapshots survive discovery of same-cycle replacements and share metadata across regions', async t => {
  setup(t);
  const original = catalog(), updated = catalog(original.revision, '2026-09-17T00:00:00Z');
  const ca = await save(plan(original)), nv = await save(plan(original, 'us-NV'));
  assert.equal(ca.snapshotId, nv.snapshotId);
  assert.equal(ca.catalog, undefined, 'large catalog metadata is stored once');
  records.set('catalog:latest', updated);
  const { bundles } = await restoreSavedBundles();
  assert.equal(bundles.length, 2);
  assert.equal(bundles[0]!.catalog, bundles[1]!.catalog, 'readers reuse the same parsed snapshot');
  assert.equal(bundles[0]!.catalog.generatedAt, original.generatedAt);
  const next = await persistBundleSnapshot(plan(updated));
  assert.notEqual(next.snapshotId, ca.snapshotId, 'a cycle date alone does not identify a build');
});

test('legacy saved catalogs without export identities allow cache-only reference reads', async t => {
  setup(t);
  await save(plan(catalog()));
  const { bundles } = await restoreSavedBundleMetadata();
  assert.equal(bundles[0]!.catalog.navigation[0]!.cacheOnly, true);
  assert.equal(bundles[0]!.catalog.airways!.cacheOnly, true);
  const pinned = catalog();
  pinned.navigation = pinned.navigation.map(resource => ({ ...resource, jsonSha256: 'a'.repeat(64) }));
  await save(plan(pinned));
  assert.equal((await restoreSavedBundleMetadata()).bundles[0]!.catalog.navigation[0]!.cacheOnly, undefined);
});

test('pending updates keep the previous snapshot; eviction preserves the activated edition and reports missing files', async t => {
  setup(t);
  const original = catalog(), updated = catalog(original.revision, '2026-09-17T00:00:00Z');
  const old = await save(plan(original));
  const pending = await save(plan(updated), false);
  records.set(`region:${pending.id}`, { ...pending, previous: old });
  assert.equal((await restoreSavedBundles()).bundles[0]!.catalog.generatedAt, original.generatedAt);
  const complete = { ...pending, completedAt: Date.now() };
  records.set(`region:${pending.id}`, complete);
  assert.equal((await restoreSavedBundles()).bundles[0]!.catalog.generatedAt, updated.generatedAt);
  present.clear();
  const { bundles: evicted } = await restoreSavedBundles();
  assert.equal(evicted[0]!.catalog.generatedAt, updated.generatedAt);
  assert.equal(evicted[0]!.unavailable, true);
});

test('committed ownership loads without reading saved bytes and survives a later health-check failure', async t => {
  setup(t);
  const original = catalog();
  await save(plan(original));
  t.mock.method(records, 'set', () => { throw new Error('Committed metadata must not be rewritten'); });
  t.mock.method(present, 'has', () => { throw new Error('Temporary storage failure'); });
  const { bundles } = await restoreSavedBundleMetadata();
  assert.equal(bundles[0]!.catalog.generatedAt, original.generatedAt);
  assert.equal(bundles[0]!.unavailable, undefined);
  const checked = await checkSavedBundleAvailability(bundles);
  assert.deepEqual(checked.bundles, bundles);
  assert.match(checked.issues[0]!.message, /Temporary storage failure/);
  assert.equal((await restoreSavedBundleMetadata()).bundles[0]!.key, bundles[0]!.key);
});

test('legacy adoption leaves incomplete selections untouched', async t => {
  setup(t);
  const legacy = plan(catalog());
  records.set(`region:${legacy.id}`, legacy);
  assert.deepEqual((await restoreSavedBundleMetadata()).bundles, []);
  assert.equal(records.get(`region:${legacy.id}`), legacy);
  assert.equal([...records.keys()].some(key => key.startsWith('bundle-snapshot:')), false);
});

test('a legacy cache-read failure cannot discard another region’s committed ownership at startup', async t => {
  setup(t);
  const original = catalog();
  await save(plan(original));
  const legacy = plan(original, 'us-NV');
  legacy.files = legacy.files.map(file => ({ ...file, url: `${file.url}?legacy` }));
  records.set(`region:${legacy.id}`, legacy);
  const has = present.has.bind(present);
  t.mock.method(present, 'has', (url: string) => {
    if (url.endsWith('?legacy')) throw new Error('Temporary legacy storage failure');
    return has(url);
  });
  const { bundles, issues } = await restoreSavedBundleMetadata();
  assert.deepEqual(bundles.map(bundle => bundle.plan.regionId), ['us-CA']);
  assert.equal(bundles[0]!.catalog.generatedAt, original.generatedAt);
  assert.equal(records.get(`region:${legacy.id}`), legacy);
  assert.equal(issues[0]!.planId, legacy.id);
  assert.match(issues[0]!.message, /Temporary legacy storage failure/);
});

test('unreadable records are reported independently and cannot hide healthy committed regions', async t => {
  setup(t);
  records.set('region:unreadable', { id: 'unreadable', broken: true });
  await save(plan(catalog()));
  const result = await restoreSavedBundleMetadata();
  assert.equal(result.bundles.length, 1);
  assert.equal(result.issues[0]!.planId, 'unreadable');
});

test('failed snapshot reads retain prior ownership while successful removal releases it', async t => {
  setup(t);
  const active = await save(plan(catalog()));
  const initial = await restoreSavedBundleMetadata();
  records.delete(`bundle-snapshot:${active.snapshotId}`);
  const unavailable = await restoreSavedBundleMetadata();
  assert.equal(unavailable.issues[0]!.planId, active.id);
  assert.deepEqual(retainFailedBundleOwnership(unavailable, initial.bundles), initial.bundles);
  records.delete(`region:${active.id}`);
  assert.deepEqual(retainFailedBundleOwnership(await restoreSavedBundleMetadata(), initial.bundles), []);
});

test('legacy adoption does not overwrite a selection while another window holds the download lock', async t => {
  setup(t);
  const legacy = plan(catalog());
  records.set(`region:${legacy.id}`, legacy);
  legacy.files.forEach(file => present.add(file.url));
  t.mock.method(navigator.locks, 'request', async (_name: string, _options: LockOptions, callback: LockGrantedCallback<void>) => callback(null));
  const { bundles: restored } = await restoreSavedBundleMetadata();
  assert.equal(restored[0]!.catalog.generatedAt, legacy.catalog!.generatedAt);
  assert.equal(records.get(`region:${legacy.id}`), legacy, 'the contended record stays untouched');
});

test('legacy adoption compares the original record under the lock before writing', async t => {
  setup(t);
  const legacy = plan(catalog());
  records.set(`region:${legacy.id}`, legacy);
  legacy.files.forEach(file => present.add(file.url));
  const replacement = { ...legacy, title: 'Selection updated by another window' };
  t.mock.method(navigator.locks, 'request', async (_name: string, _options: LockOptions, callback: LockGrantedCallback<void>) => {
    records.set(`region:${legacy.id}`, replacement);
    return callback({} as Lock);
  });
  await restoreSavedBundleMetadata();
  assert.equal(records.get(`region:${legacy.id}`), replacement);
});

test('adopting a previous legacy selection preserves its staged update', async t => {
  setup(t);
  const original = catalog(), updated = catalog(original.revision, '2026-09-17T00:00:00Z');
  const previous = plan(original);
  const pending = await save(plan(updated), false);
  const root = { ...pending, previous };
  records.set(`region:${root.id}`, root);
  const { bundles: restored } = await restoreSavedBundleMetadata();
  assert.equal(restored[0]!.catalog.generatedAt, original.generatedAt);
  const migrated = records.get(`region:${root.id}`) as DownloadPlan;
  assert.deepEqual({ ...migrated, previous: undefined }, { ...root, previous: undefined });
  assert.ok(migrated.previous!.completedAt);
  assert.match(migrated.previous!.snapshotId!, /^[a-f0-9]{64}$/);
  assert.equal(migrated.previous!.catalog, undefined);
  assert.equal((await restoreSavedBundleMetadata()).bundles[0]!.catalog.generatedAt, original.generatedAt);
});

test('same-catalog selection dependency changes invalidate readers without making availability part of identity', async t => {
  setup(t);
  const original = plan(catalog());
  await save({ ...original, references: [...original.references, { id: 'chart-supplements', url: 'https://charts.test/cs?v=1' }] });
  const first = (await restoreSavedBundleMetadata()).bundles[0]!;
  await save({ ...original, references: [...original.references, { id: 'chart-supplements', url: 'https://charts.test/cs?v=2' }] });
  const updated = (await restoreSavedBundleMetadata()).bundles[0]!;
  assert.equal(updated.plan.snapshotId, first.plan.snapshotId);
  assert.notEqual(updated.key, first.key);
  present.clear();
  const { bundles: missing } = await checkSavedBundleAvailability([updated]);
  assert.equal(missing[0]!.unavailable, true);
  assert.equal(missing[0]!.key, updated.key);
});

test('legacy adoption requires exact catalog dependencies and never assigns a freshly discovered build', async t => {
  setup(t);
  const original = catalog(), updated = catalog(original.revision, '2026-09-17T00:00:00Z');
  const { catalog: _catalog, bounds: _bounds, ...legacy } = plan(original);
  records.set(`region:${legacy.id}`, legacy);
  legacy.files.forEach(file => present.add(file.url));
  records.set('catalog:latest', updated);
  assert.deepEqual((await restoreSavedBundles()).bundles, []);
  records.set('catalog:legacy', original);
  assert.equal((await restoreSavedBundles()).bundles[0]!.catalog.generatedAt, original.generatedAt);
  const migrated = records.get(`region:${legacy.id}`) as DownloadPlan;
  assert.match(migrated.snapshotId!, /^[a-f0-9]{64}$/);
  assert.ok(migrated.completedAt);
  records.delete('catalog:legacy');
  assert.equal((await restoreSavedBundles()).bundles[0]!.catalog.generatedAt, original.generatedAt);
});
