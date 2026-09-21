import assert from 'node:assert/strict';
import test from 'node:test';
import type { FeatureCollectionResponse } from '@zlayer/contracts';
import { createRouteResolver, routeDraftFromText, type RouteApproach } from '@zlayer/domain';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import { syncRoute, ROUTE_SOURCE_ID } from '../src/layers/routes/renderer';
import { setRouteApproach } from '../src/layers/routes/draft';
import { routeSegments } from '../src/layers/terrain/geometry';
import { arizonaTerminal } from './fixtures/route-approach-arizona';

const airports: FeatureCollectionResponse = { type: 'FeatureCollection', meta: {
  layer: 'airports', revision: '2026-09-03', returned: 1, truncated: false,
}, features: [{ type: 'Feature', id: 'KIWA', properties: { ident: 'KIWA' },
  geometry: { type: 'Point', coordinates: [-111.655, 33.307] } }] };
const selected: RouteApproach = { airportId: 'KIWA', procedureId: 'ils', name: 'ILS OR LOC RWY 30C', cycle: '2609',
  entry: { routeId: 'KIWA:I30C', transitionId: 'vectors', name: 'VTF', effectiveDate: '2026-09-03' } };

for (const missing of [false, true]) test(`KIWA saved route renders its hold ${missing ? 'after a gap' : 'after the schematic return'}`, () => {
  const resolve = createRouteResolver([airports], undefined, arizonaTerminal(missing));
  const original = routeDraftFromText('KIWA');
  const draft = setRouteApproach(original, original.entries[0]!, selected);
  for (const saved of [draft, JSON.parse(JSON.stringify(draft))]) {
    const plan = resolve(saved);
    assert.equal(plan.issues.length, missing ? 1 : 0);
    if (missing) assert.equal(plan.issues[0]!.code, 'approach-discontinuity');
    const hold = plan.waypoints.find(p => p.ident === 'IWA')!;
    assert.equal(hold.approachPhase, 'missed');
    assert.equal(hold.approachHold!.turn, 'R');
    assert.equal(hold.approachHold!.inboundCourse, 13);
    assert.equal(hold.approachHold!.length, '1 MIN');
    assert.equal(hold.approachHold!.arrivalCourse, missing ? undefined : 208);
    assert.ok(!plan.legs.some(l => l.approachPhase === 'missed'));
    assert.equal(plan.distanceNm, plan.legs.reduce((sum, l) => sum + l.distanceNm, 0));
    assert.deepEqual(routeSegments([plan]), routeSegments([{ ...plan, approachDepictions: [] }]));
    let rendered: FeatureCollection | undefined;
    syncRoute({ setGlobalStateProperty() {}, getSource: (id: string) => ({ setData(data: FeatureCollection) {
      if (id === ROUTE_SOURCE_ID) rendered = data;
    } }) } as unknown as MapLibreMap, plan);
    assert.ok(rendered!.features.some(f => f.geometry.type === 'Point' && f.properties?.ident === 'IWA'));
    assert.ok(rendered!.features.some(f => f.properties?.routeKind === 'approach-hold' && f.properties.approachPhase === 'missed'));
    assert.equal(rendered!.features.filter(f => f.properties?.routeKind === 'approach-missed').length, missing ? 0 : 1);
  }
});
