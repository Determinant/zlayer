import assert from 'node:assert/strict';
import test from 'node:test';
import type { Bounds, CatalogResponse, GeoPointFeature } from '@zlayer/contracts';
import type { SavedBundle } from '../src/offline/bundle-repository';
import { visibleSavedBundles } from '../src/offline/visible-bundles';
import { createWorkspaceReadContext, catalogForFeature, supplementForFeature, regionalCatalogKey, navigationSourceKey } from '../src/workspace/read-context';
import { regionalTileParts } from '../src/layers/charts/regional-tiles';
import { fetchNavigation, fetchNavigationCollections, fetchNavigationResult, regionalNavigationLayers } from '../src/layers/navigation/api';

import { coverageContainsPoint, worldPoint, regionContainsPoint } from '../src/offline/region-coverage';
import { OFFLINE_REGIONS } from '../src/offline/regions';
import { regionAirportIds } from '../src/layers/plates/supplement-snapshot';

const catalog = (revision: string): CatalogResponse => ({ schemaVersion: 1, revision,
  generatedAt: `${revision}T00:00:00Z`, charts: [], weather: [],
  navigation: [{ id: 'airports', title: 'Airports', count: 3, sourceCount: 3, minZoom: 0,
    url: `https://regional.test/${revision}/airports.json` }],
});
const bundle = (catalog: CatalogResponse, id: string, bounds: Bounds[]): SavedBundle => ({ catalog, bounds, key: `${id}:${catalog.revision}`,
  plan: { id, regionId: id, title: id, revision: catalog.revision, files: [], references: [] } });
const feature = (ident: string, x: number, state?: string): GeoPointFeature => ({ type: 'Feature', id: ident,
  geometry: { type: 'Point', coordinates: [x, state === 'NV' ? 39.4991 : state === 'CA' ? 37.66 : 30] }, properties: { ident, kind: 'airport', ...(state ? { state } : {}) } });

test('saved badge follows visible regional coverage and excludes editions hidden by newer downloads', () => {
  const ca = bundle(catalog('2026-08-06'), 'us-CA', [[-124, 32, -114, 42]]);
  const nv = bundle(catalog('2026-09-03'), 'us-NV', [[-120, 35, -114, 42]]);
  const bundles = [nv, ca];
  assert.deepEqual(visibleSavedBundles(bundles, undefined), []);
  assert.deepEqual(visibleSavedBundles([], [-123, 36, -122, 38]), [], 'viewing and caching an area does not explicitly save it');
  assert.deepEqual(visibleSavedBundles(bundles, [-76, 39, -70, 43]), [], 'California saves do not label the East Coast saved');
  assert.deepEqual(visibleSavedBundles(bundles, [-123, 36, -122, 38]), [ca]);
  assert.deepEqual(visibleSavedBundles(bundles, [-119.8, 39.4, -119.7, 39.6]), [nv]);
  assert.deepEqual(visibleSavedBundles(bundles, [-122, 36, -118, 38]), [nv, ca], 'a view can include portions of two saved editions');
  assert.deepEqual(visibleSavedBundles(bundles, [-110, 36, -108, 38]), [], 'outside saved states');
  const newCa = { ...ca, catalog: catalog('2026-09-03') };
  assert.deepEqual(visibleSavedBundles([newCa, ca], [-123, 36, -122, 38]), [newCa]);
});

test('saved coverage badge handles antimeridian views and wrapped world copies', () => {
  const alaska = bundle(catalog('2026-09-03'), 'us-AK', [[172, 51, 179, 54], [-179, 51, -160, 65]]);
  const ca = bundle(catalog('2026-09-03'), 'us-CA', [[-124, 32, -114, 42]]);
  assert.deepEqual(visibleSavedBundles([alaska, ca], [170, 50, -170, 55]), [alaska]);
  assert.deepEqual(visibleSavedBundles([alaska, ca], [530, 50, 550, 55]), [alaska]);
  assert.deepEqual(visibleSavedBundles([alaska, ca], [237, 36, 238, 38]), [ca]);
  assert.deepEqual(visibleSavedBundles([alaska, ca], [-540, -85, 540, 85]), [alaska, ca]);
});

test('regional edition ownership stays distinct from the online browsing date and national route export', () => {
  const browsing = catalog('2026-10-01'), older = catalog('2026-08-06'), saved = catalog('2026-09-03');
  const resolved = createWorkspaceReadContext(browsing, [bundle(saved, 'us-NV', [[-120, 20, -110, 45]]),
    bundle(older, 'us-CA', [[-125, 20, -115, 45]])]);
  assert.equal(resolved.routing.revision, saved.revision, 'national route data uses the newest complete saved export');
  assert.equal(catalogForFeature(resolved, feature('CA', -122.12, 'CA')), older, 'the point uses the same state boundary as the charts');
  assert.equal(catalogForFeature(resolved, feature('NV', -119.7681, 'NV')), saved);
  assert.equal(catalogForFeature(resolved, feature('OTHER', -80)), browsing);
  assert.equal(catalogForFeature({ ...resolved }, feature('OTHER', -80)), browsing, 'copying a context preserves source ownership');
  assert.equal(catalogForFeature(structuredClone(resolved), feature('CA', -122.12, 'CA'))!.revision, older.revision);
  assert.ok(regionalCatalogKey(resolved).includes('2026-08-06'));
});

test('chart tiles are partitioned by saved coverage, including overlaps and the date line', () => {
  const browsing = catalog('2026-10-01'), older = catalog('2026-08-06'), saved = catalog('2026-09-03');
  const resolved = createWorkspaceReadContext(browsing, [bundle(saved, 'new', [[-120, -80, -100, 80]]),
    bundle(older, 'old', [[-130, -80, -110, 80], [170, -80, 180, 80]])]);
  const parts = regionalTileParts(resolved, { z: 0, x: 0, y: 0 });
  const at = (longitude: number) => {
    const x = (longitude + 180) / 360 * 256;
    return parts.filter(part => coverageContainsPoint(part.geometry, [x, 128]));
  };
  assert.equal(at(-125)[0]!.catalog, older);
  assert.equal(at(-115)[0]!.catalog, saved);
  assert.equal(at(175)[0]!.catalog, older);
  assert.equal(at(-175)[0]!.catalog, browsing);
  assert.equal(at(0)[0]!.catalog, browsing);
  assert.ok([-125, -115, 175, -175, 0].every(x => at(x).length === 1));
  const area = parts.flatMap(part => part.geometry).reduce((sum, polygon) => sum + polygon.reduce((area, ring, index) => {
    const signed = ring.slice(1).reduce((value, point, i) => value + ring[i]![0] * point[1] - point[0] * ring[i]![1], 0) / 2;
    return area + (index ? -1 : 1) * Math.abs(signed);
  }, 0), 0);
  assert.ok(Math.abs(area - 256 ** 2) < 0.000001, 'partition has no gaps or duplicate coverage');
});

test('navigation details use saved regional versions online and survive missing browsing data offline', async t => {
  const browsing = catalog('2026-10-01'), older = catalog('2026-08-06'), saved = catalog('2026-09-03');
  const resolved = createWorkspaceReadContext(browsing, [bundle(saved, 'us-NV', [[-120, 20, -110, 45]]),
    bundle(older, 'us-CA', [[-125, 20, -115, 45]])]);
  const points = [feature('CA', -122.12, 'CA'), feature('NV', -119.7681, 'NV'), feature('OTHER', -80)];
  let offline = false;
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (offline && url.includes(browsing.revision)) throw new TypeError('Offline');
    const revision = url.match(/\d{4}-\d{2}-\d{2}/)![0];
    return Response.json({ type: 'FeatureCollection', metadata: { effectiveDate: revision, source: 'Test' },
      features: points.map(point => ({ ...point, properties: { ...point.properties, name: revision } })) });
  });
  const result = await fetchNavigation(resolved.routing.navigation[0]!, resolved.routing.revision, [], resolved);
  const byId = new Map(result.features.map(point => [point.id, point.properties.name]));
  assert.equal(byId.get('CA'), older.revision);
  assert.equal(byId.get('NV'), saved.revision);
  assert.equal(byId.get('OTHER'), browsing.revision);
  offline = true;
  const absentBrowsing = { ...browsing, navigation: browsing.navigation.map(resource => ({ ...resource, url: `${resource.url}?uncached` })) };
  const fallback = createWorkspaceReadContext(absentBrowsing, [bundle(older, 'us-CA', [[-125, 20, -115, 45]])]);
  const offlineResult = await fetchNavigation(fallback.routing.navigation[0]!, fallback.routing.revision, [], fallback);
  assert.equal(offlineResult.features.find(point => point.id === 'CA')!.properties.name, older.revision);
});

test('Reno belongs to Nevada for charts, details, downloads and badges even with newer California saved', () => {
  const browsing = catalog('2026-10-01'), september = catalog('2026-09-03'), august = catalog('2026-08-06');
  const region = (code: string) => OFFLINE_REGIONS.find(region => region.code === code)!;
  const ca = bundle(september, 'us-CA', region('CA').bounds), nv = bundle(august, 'us-NV', region('NV').bounds);
  const reno = feature('KRNO', -119.7681, 'NV');
  const resolved = createWorkspaceReadContext(browsing, [ca, nv]);
  assert.equal(catalogForFeature(resolved, reno), august);
  const parts = regionalTileParts(resolved, { z: 0, x: 0, y: 0 });
  const pixel = worldPoint(reno.geometry.coordinates).map(value => value * 256) as [number, number];
  assert.deepEqual(parts.filter(part => coverageContainsPoint(part.geometry, pixel)).map(part => part.catalog), [august]);
  assert.deepEqual(visibleSavedBundles([ca, nv], [-119.8, 39.4, -119.7, 39.6]), [nv]);
  assert.equal(regionAirportIds([reno], region('CA')).size, 0);
  assert.ok(regionAirportIds([reno], region('NV')).has('KRNO'));
  const californiaOnly = createWorkspaceReadContext(browsing, [ca]);
  assert.equal(catalogForFeature(californiaOnly, reno), browsing, 'extra downloaded chart bytes do not select neighboring editions');
  assert.deepEqual(visibleSavedBundles([ca], [-119.8, 39.4, -119.7, 39.6]), []);
  assert.equal(catalogForFeature(resolved, { ...reno, properties: { ...reno.properties, state: 'CA' } }), august,
    'a stale state property cannot override the shared geometry');
});

test('state masks include inhabited territories and both sides of Alaska, with no neighboring envelope ownership', () => {
  for (const [code, x, y] of [
    ['CA', -122.12, 37.66], ['NV', -119.7681, 39.4991], ['AK', 173.18, 52.83], ['AK', -149.99, 61.17],
    ['GU', 144.8, 13.49], ['MP', 145.73, 15.12], ['AS', -170.7105, -14.331], ['PR', -66, 18.44], ['VI', -64.97, 18.34],
  ] as const) assert.ok(regionContainsPoint(`us-${code}`, [], [x, y]), code);
  assert.equal(regionContainsPoint('us-CA', [], [-119.7681, 39.4991]), false);
});

function regionalFixture(name: string) {
  const make = (revision: string) => {
    const value = catalog(revision);
    value.navigation[0]!.url += `?case=${encodeURIComponent(name)}`;
    return value;
  };
  const browsing = make('2026-10-01'), ca = make('2026-09-03'), nv = make('2026-08-06');
  const saved = [ca, nv].map((value, i) => {
    const region = OFFLINE_REGIONS.find(region => region.code === (i ? 'NV' : 'CA'))!;
    return bundle(value, region.id, region.bounds);
  });
  const scope = createWorkspaceReadContext(browsing, saved);
  const points = [feature('CA', -122.12, 'CA'), feature('NV', -119.7681, 'NV'), feature('OTHER', -80)];
  const response = (url: string) => Response.json({ type: 'FeatureCollection',
    metadata: { effectiveDate: url.match(/\d{4}-\d{2}-\d{2}/)![0], source: 'Test' }, features: points });
  const load = () => fetchNavigationCollections(regionalNavigationLayers(scope), scope.routing.revision, [], scope);
  return { browsing, ca, nv, saved, scope, response, load };
}

test('one failed saved export preserves healthy regions, excludes fallback there, and retries without reloading successes', async t => {
  const fixture = regionalFixture(t.name);
  let failed = true;
  const calls = new Map<string, number>();
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    calls.set(url, (calls.get(url) ?? 0) + 1);
    if (failed && url === fixture.nv.navigation[0]!.url) throw new TypeError('Offline');
    return fixture.response(url);
  });
  const first = await fixture.load();
  assert.deepEqual(first.collections[0]!.features.map(feature => feature.id).sort(), ['CA', 'OTHER']);
  assert.deepEqual(first.unavailable, [], 'the airport layer remains usable');
  assert.deepEqual(first.issues.map(issue => [issue.regionId, issue.revision, issue.layer]), [['us-NV', '2026-08-06', 'airports']]);
  failed = false;
  const retry = await fixture.load();
  assert.equal(retry.collections[0]!.features.length, 3);
  assert.deepEqual(retry.issues, []);
  assert.equal(retry.collections[0]!.features.find(feature => feature.id === 'NV')!.properties.dataRevision, '2026-08-06');
  assert.equal(calls.get(fixture.ca.navigation[0]!.url), 1);
  assert.equal(calls.get(fixture.browsing.navigation[0]!.url), 1);
  assert.equal(calls.get(fixture.nv.navigation[0]!.url), 2);
});

test('missing browsing and newest saved exports do not prevent an older healthy region from loading', async t => {
  const fixture = regionalFixture(t.name);
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url !== fixture.nv.navigation[0]!.url) throw new TypeError('Offline');
    return fixture.response(url);
  });
  const result = await fixture.load();
  assert.deepEqual(result.collections[0]!.features.map(feature => feature.id).sort(), ['NV', 'OTHER']);
  assert.equal(result.issues.length, 2);
  assert.equal(result.issues[0]!.fallbackRevision, fixture.nv.revision);
  assert.equal(result.issues[1]!.regionId, 'us-CA');
  const outside = result.collections[0]!.features.find(feature => feature.id === 'OTHER')!;
  assert.equal(catalogForFeature(fixture.scope, outside), fixture.nv,
    'plates outside saved coverage must follow the fallback feature’s source catalog');
});

test('shared reference identities still resolve through the owning region catalog', () => {
  const ca = catalog('2026-09-03'), nv = { ...ca, charts: [] };
  const regions = ['CA', 'NV'].map(code => OFFLINE_REGIONS.find(region => region.code === code)!);
  const context = createWorkspaceReadContext(catalog('2026-08-06'), [
    bundle(ca, regions[0]!.id, regions[0]!.bounds), bundle(nv, regions[1]!.id, regions[1]!.bounds),
  ]);
  assert.equal(navigationSourceKey(ca), navigationSourceKey(nv));
  const reno = feature('NV', -119.7681, 'NV');
  reno.properties.dataSourceKey = navigationSourceKey(nv);
  assert.equal(catalogForFeature(context, reno), nv, 'regional supplement ownership must not follow another catalog object');
});

test('same-cycle fallback keeps exact source ownership through serialization and never adopts a retired source', async t => {
  const original = catalog('2026-09-03'), replacement = catalog('2026-09-03');
  original.navigation[0]!.url += '?build=original';
  replacement.navigation[0]!.url += '?build=replacement';
  replacement.generatedAt = '2026-09-17T00:00:00Z';
  const region = OFFLINE_REGIONS.find(region => region.code === 'NV')!;
  const scope = createWorkspaceReadContext(replacement, [bundle(original, region.id, region.bounds)]);
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0]) => {
    if (String(input).includes('replacement')) throw new TypeError('Browsing unavailable');
    return Response.json({ type: 'FeatureCollection', metadata: { effectiveDate: original.revision, source: 'Test' },
      features: [feature('CA', -122.12, 'CA'), feature('NV', -119.7681, 'NV'), feature('OTHER', -80)] });
  });
  const result = await fetchNavigationCollections(regionalNavigationLayers(scope), scope.routing.revision, [], scope);
  const outside = result.collections[0]!.features.find(feature => feature.id === 'OTHER')!;
  assert.equal(catalogForFeature(scope, outside), original);
  assert.equal(catalogForFeature(structuredClone(scope), structuredClone(outside))!.generatedAt, original.generatedAt);
  const removed = createWorkspaceReadContext(replacement, []);
  assert.equal(catalogForFeature(removed, outside), undefined, 'an old feature cannot silently switch to browsing metadata');
  assert.deepEqual(supplementForFeature(removed, outside), { url: '' });
});

test('all failed exports report unavailable products; a subsequent repair can recover the same scope', async t => {
  const fixture = regionalFixture(t.name);
  let failed = true;
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0]) => {
    if (failed) throw new TypeError('Offline');
    return fixture.response(String(input));
  });
  const result = await fixture.load();
  assert.deepEqual(result.collections, []);
  assert.deepEqual(result.unavailable, ['airports']);
  assert.equal(result.issues.length, 3);
  failed = false;
  const repaired = await fetchNavigationResult(fixture.scope.routing.navigation[0]!, fixture.scope.routing.revision, [], fixture.scope);
  assert.equal(repaired.collection!.features.length, 3);
  assert.deepEqual(repaired.issues, []);
});

test('a product omitted from the newest saved catalog remains available in other regions', async t => {
  const fixture = regionalFixture(t.name);
  fixture.ca.navigation = [];
  const scope = createWorkspaceReadContext(fixture.browsing, fixture.saved);
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0]) => fixture.response(String(input)));
  assert.equal(scope.routing.navigation.length, 0, 'routing catalog policy is unchanged');
  const result = await fetchNavigationCollections(regionalNavigationLayers(scope), scope.routing.revision, [], scope);
  assert.deepEqual(result.collections[0]!.features.map(feature => feature.id).sort(), ['NV', 'OTHER']);
  assert.equal(result.issues[0]!.regionId, 'us-CA');
});

test('an older saved edition fully hidden by the active state is not a navigation dependency', async t => {
  const fixture = regionalFixture(t.name);
  const oldCa = { ...fixture.saved[0]!, catalog: fixture.nv, key: 'older-california' };
  const scope = createWorkspaceReadContext(fixture.browsing, [fixture.saved[0]!, oldCa]);
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input); urls.push(url);
    if (url === fixture.nv.navigation[0]!.url) throw new TypeError('Old unused export missing');
    return fixture.response(url);
  });
  const result = await fetchNavigationCollections(regionalNavigationLayers(scope), scope.routing.revision, [], scope);
  assert.deepEqual(result.issues, []);
  assert.equal(urls.length, 2, 'only browsing and the selected saved state load');
});
