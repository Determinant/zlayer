import { draftSnapshot } from './helpers/route-draft';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { GeoPointFeature, NavigationData, PreferredRouteRecord, PreferredRoutesData, PreferredRoutesResource } from '@zlayer/contracts';
import { createRouteResolver, routeEntryPins } from '@zlayer/domain';
import { fetchPreferredRoutes } from '../src/layers/routes/api';
import { preferredRouteDraft } from '../src/layers/routes/draft';

const data: PreferredRoutesData = { type: 'ZLayerPreferredRoutes', metadata: {
  effectiveDate: '2026-09-03', source: 'FAA NASR',
}, routes: [{ id: 'preferred-route:SBA:SMO:TEC:4', originId: 'SBA', destinationId: 'SMO',
  routeNumber: 4, routeType: 'TEC', route: 'KWANG CMA', altitude: 'PQ70', segments: [] }] };
const resource: PreferredRoutesResource = {
  id: 'preferred-routes', title: 'Preferred routes', count: 1, sourceCount: 1, url: '/nav/preferred-routes.json?v=test',
};

test('preferred routes deduplicate requests, reject invalid feeds, and retry failures', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let requests = 0;
  let response = data;
  globalThis.fetch = async () => { requests++; return Response.json(response); };
  await Promise.all([fetchPreferredRoutes(resource, '2026-09-03'), fetchPreferredRoutes(resource, '2026-09-03')]);
  assert.equal(requests, 1);
  const updated = { ...resource, url: '/nav/preferred-routes.json?v=updated' };
  response = { ...data, routes: [] };
  await assert.rejects(fetchPreferredRoutes(updated, '2026-09-03'), /invalid document/);
  response = { ...data, metadata: { ...data.metadata, effectiveDate: '2026-08-06' } };
  await assert.rejects(fetchPreferredRoutes(updated, '2026-09-03'), /invalid document/);
  response = data;
  assert.deepEqual(await fetchPreferredRoutes(updated, '2026-09-03'), data);
  assert.equal(requests, 4);
});

test('using a recommended route pins both selected airports and adds only the published intermediate entries', () => {
  const airport = (id: string, faaId: string): GeoPointFeature => ({ type: 'Feature', id,
    geometry: { type: 'Point', coordinates: [-120, 35] }, properties: { faaId, icaoId: `K${faaId}` } });
  assert.deepEqual(draftSnapshot(preferredRouteDraft(data.routes[0]!, { origin: airport('sba', 'SBA'), destination: airport('smo', 'SMO') })), {
    input: 'KSBA KWANG CMA KSMO', pinnedFeatureIds: { 0: 'sba', 3: 'smo' },
  });
});

function typedRouteFixture() {
  const origin: GeoPointFeature = { type: 'Feature', id: 'airport:SBA',
    geometry: { type: 'Point', coordinates: [-119.8, 34.4] }, properties: { faaId: 'SBA', icaoId: 'KSBA' } };
  const destination: GeoPointFeature = { ...origin, id: 'airport:SMO', properties: { faaId: 'SMO', icaoId: 'KSMO' } };
  const airport: GeoPointFeature = { ...origin, id: 'airport:CMA', properties: { faaId: 'CMA', icaoId: 'KCMA' } };
  const navaid: GeoPointFeature = { ...origin, id: 'navaid:CMA', properties: {
    ident: 'CMA', type: 'VOR/DME', state: 'CA', country: 'US',
  } };
  const navigation: NavigationData = {
    airports: { type: 'FeatureCollection', features: [origin, destination, airport],
      meta: { layer: 'airports', revision: '2026-09-03', returned: 3, truncated: false } },
    navaids: { type: 'FeatureCollection', features: [navaid,
      { ...navaid, id: 'navaid:other', properties: { ...navaid.properties, type: 'NDB' } }],
      meta: { layer: 'navaids', revision: '2026-09-03', returned: 2, truncated: false } },
  };
  const route: PreferredRouteRecord = { ...data.routes[0]!, route: 'CMA',
    segments: [{ sequence: 5, value: 'CMA', type: 'NAVAID', state: 'CA', country: 'US', navaidType: 'VOR/DME' }],
  };
  return { route, pair: { origin, destination }, navigation, navaid };
}

test('published segment types keep a NAVAID from resolving to a nearby airport with the same identifier', () => {
  const { route, pair, navigation, navaid } = typedRouteFixture();
  const draft = preferredRouteDraft(route, pair, navigation)!;
  assert.equal(routeEntryPins(draft.entries)[1], navaid.id);
  const plan = createRouteResolver(Object.values(navigation))(draft);
  assert.deepEqual(plan.waypoints.map(point => point.feature.id), [pair.origin.id, navaid.id, pair.destination.id]);
  assert.deepEqual(plan.issues, []);
});

test('inconsistent segment metadata blocks import instead of losing waypoint constraints', () => {
  const { route, pair, navigation } = typedRouteFixture();
  for (const malformed of [
    { ...route, route: 'CMA VNY' }, // A segment is missing.
    { ...route, route: 'VNY' }, // Same count, different waypoint.
    { ...route, route: 'DCT' }, // Metadata must not be dropped for a direct route either.
    { ...route, segments: [{ sequence: 5, value: 'DCT', type: 'DIRECT' }] },
  ]) {
    assert.equal(preferredRouteDraft(malformed, pair, navigation), undefined);
  }
  assert.ok(preferredRouteDraft({ ...route, segments: [] }, pair, navigation), 'text-only legacy feeds remain supported');
});

test('typed recommendations cannot import missing, mismatched, ambiguous or unpinnable waypoints', () => {
  const { route, pair, navigation, navaid } = typedRouteFixture();
  for (const [label, features] of [
    ['missing layer', undefined], ['missing waypoint', []],
    ['wrong state', [{ ...navaid, properties: { ...navaid.properties, state: 'AK' } }]],
    ['wrong NAVAID type', [{ ...navaid, properties: { ...navaid.properties, type: 'NDB' } }]],
    ['ambiguous', [navaid, { ...navaid, id: 'navaid:duplicate' }]],
    ['no stable ID', [{ type: navaid.type, geometry: navaid.geometry, properties: navaid.properties }]],
  ] as const) {
    const available: NavigationData = { airports: navigation.airports! };
    if (features) available.navaids = { ...navigation.navaids!, features: [...features] };
    assert.equal(preferredRouteDraft(route, pair, available), undefined, label);
  }
  const fixRoute = { ...route, segments: [{ sequence: 5, value: 'CMA', type: 'FIX' }] };
  assert.equal(preferredRouteDraft(fixRoute, pair, navigation), undefined, 'a NAVAID cannot replace a published FIX');
  const fix = { ...navaid, id: 'fix:CMA' };
  const restored = { ...navigation, fixes: { ...navigation.navaids!, meta: { ...navigation.navaids!.meta, layer: 'fixes' as const }, features: [fix] } };
  const draft = preferredRouteDraft(fixRoute, pair, restored)!;
  const plan = createRouteResolver(Object.values(restored))(draft);
  assert.equal(plan.waypoints[1]!.feature.id, fix.id, 'restoring the required product enables the correct route');
});

test('published intermediate AIRPORT segments also pin their exact identity', () => {
  const { route, pair, navigation } = typedRouteFixture();
  const airportRoute = { ...route, segments: [{ sequence: 5, value: 'CMA', type: 'AIRPORT' }] };
  assert.equal(preferredRouteDraft(airportRoute, pair, { navaids: navigation.navaids! }), undefined);
  const draft = preferredRouteDraft(airportRoute, pair, navigation)!;
  assert.equal(routeEntryPins(draft.entries)[1], 'airport:CMA');
});
