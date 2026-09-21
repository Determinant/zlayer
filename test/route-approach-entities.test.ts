import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isTerminalProceduresData, type FeatureCollectionResponse, type GeoPointFeature } from '@zlayer/contracts';
import { createRouteResolver, routeDraftFromText, type RouteApproach, type RoutePlan } from '@zlayer/domain';
import { directToRoutePoint } from '../src/layers/routes/direct-to';
import { setRouteApproach } from '../src/layers/routes/draft';
import { restoreApproachSelection, routePointForFeature, routePointKeys } from '../src/layers/routes/selection';

const terminal: unknown = JSON.parse(readFileSync(new URL('./fixtures/route-approach-legs.json', import.meta.url), 'utf8'));
assert.ok(isTerminalProceduresData(terminal));
const selected: RouteApproach = { kind: 'approach' as const, source: 'chart' as const, airportId: 'KSFO', procedureId: 'ils', name: 'ILS OR LOC RWY 28R', cycle: '2609',
  entry: { routeId: 'KSFO:I28R', transitionId: 'transition:ARCHI', name: 'ARCHI', effectiveDate: '2026-09-03' } };
function collection(layer: FeatureCollectionResponse['meta']['layer'], features: GeoPointFeature[]): FeatureCollectionResponse {
  return { type: 'FeatureCollection', features, meta: { layer, revision: 'test', returned: features.length, truncated: false } };
}
const airports = collection('airports', [{ type: 'Feature', id: 'airport:KSFO',
  properties: { ident: 'KSFO', kind: 'airport' }, geometry: { type: 'Point', coordinates: [-122.375, 37.619] } }]);
let draft = routeDraftFromText('KSFO KSFO');
for (const entry of draft.entries) draft = setRouteApproach(draft, entry, selected);
const fallback = createRouteResolver([airports], undefined, terminal)(draft);
const coded = fallback.waypoints.find(point => point.ident === 'AXMUL')!;
const navigationFix: GeoPointFeature = { ...coded.feature, id: 'fix:AXMUL',
  geometry: { type: 'Point', coordinates: [coded.feature.geometry.coordinates[0] + 0.00001, coded.feature.geometry.coordinates[1]] },
  properties: { kind: 'fix', ident: 'AXMUL', name: 'AXMUL', state: 'CA', lowArtcc: 'ZOA' } };

test('approach fixes reuse navigation identity and details while retaining each occurrence, roles and coded paths', () => {
  const resolve = createRouteResolver([airports, collection('fixes', [navigationFix])], undefined, terminal);
  const plan = resolve(draft), points = plan.waypoints.filter(point => point.ident === 'AXMUL');
  assert.equal(points.length, 2);
  for (const point of points) {
    assert.equal(point.feature, navigationFix);
    assert.equal(point.layer, 'fixes');
    assert.equal(point.approachRole, coded.approachRole);
    assert.equal(point.approachPhase, coded.approachPhase);
    assert.equal(point.edit, undefined);
  }
  assert.deepEqual(plan.legs.filter(leg => leg.geometry).map(leg => leg.geometry),
    fallback.legs.filter(leg => leg.geometry).map(leg => leg.geometry));
  const target = points[1]!, key = routePointKeys(plan).get(target)!;
  assert.equal(routePointForFeature(plan, navigationFix, key), target);
  assert.equal(restoreApproachSelection(plan, coded.feature), navigationFix);
  assert.equal(routePointForFeature(plan, coded.feature, key), target);
  const childIndex = plan.waypoints.filter(point => point.source.entryId === target.source.entryId &&
    point.owners.some(owner => owner.kind === 'approach')).indexOf(target);
  const legacy = { ...coded.feature, id: `approach:${target.source.entryId}:${childIndex}:AXMUL` };
  assert.equal(routePointForFeature(plan, legacy), target);
  const next = directToRoutePoint(draft, plan, target, [-122, 37]);
  assert.equal(next.entries[1]!.pinnedFeatureId, navigationFix.id);
  assert.equal(resolve(JSON.parse(JSON.stringify(next))).waypoints[1]!.feature, navigationFix);
  // Old drafts with coded pins also resolve to the existing entity when available.
  const oldPin = { entries: [{ id: 'old', text: 'AXMUL', pinnedFeatureId: coded.feature.id! }] };
  assert.equal(resolve(oldPin).waypoints[0]!.feature, navigationFix);
  assert.deepEqual(createRouteResolver([airports], undefined, terminal)(oldPin).waypoints[0]!.feature, coded.feature);
});

test('a matching navaid keeps its type, frequency and missed-approach hold', () => {
  const hold = fallback.waypoints.find(point => point.approachHold)!;
  const navaid: GeoPointFeature = { ...hold.feature, id: `navaid:${hold.ident}`,
    properties: { kind: 'navaid', ident: hold.ident, type: 'VOR/DME', frequency: '113.90' } };
  const plan = createRouteResolver([airports, collection('navaids', [navaid])], undefined, terminal)(draft);
  const point = plan.waypoints.find(point => point.ident === hold.ident)!;
  assert.equal(point.feature, navaid);
  assert.equal(point.layer, 'navaids');
  assert.deepEqual(point.approachHold, hold.approachHold);
  assert.equal(point.approachPhase, hold.approachPhase);
});

test('different positions, airport aliases, VOTs and ambiguous matches retain the coded approach point', () => {
  const variants = [
    collection('fixes', [{ ...navigationFix, geometry: { type: 'Point', coordinates: [-100, 40] } }]),
    collection('airports', [{ ...navigationFix, properties: { ident: 'KAXM', faaId: 'AXMUL', kind: 'airport' } }]),
    collection('navaids', [{ ...navigationFix, properties: { ...navigationFix.properties, kind: 'navaid', type: 'VOT' } }]),
    collection('fixes', [navigationFix, { ...navigationFix, id: 'another:AXMUL' }]),
  ];
  for (const data of variants) {
    const plan: RoutePlan = createRouteResolver([airports, data], undefined, terminal)(draft);
    assert.deepEqual(plan.waypoints.find(point => point.ident === 'AXMUL')!.feature, coded.feature);
  }
});
