import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { isTerminalProceduresData, type ApproachRoute, type FeatureCollectionResponse } from '@zlayer/contracts';
import { approachEntryOptions, approachPreview, createRouteResolver, distanceNm, routeDraftFromText, type RouteApproach, type RoutePlan } from '@zlayer/domain';
import { setRouteApproach } from '../src/layers/routes/draft';
import { syncRoute, ROUTE_SOURCE_ID } from '../src/layers/routes/renderer';
import { routeSegments } from '../src/layers/terrain/geometry';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';

const data: unknown = JSON.parse(readFileSync(new URL('./fixtures/route-approach-north-bay.json', import.meta.url), 'utf8'));
assert.ok(isTerminalProceduresData(data));
const vor = data.approaches!.procedures.find(p => p.id === 'O69:S29')!;
const napa = data.approaches!.procedures.find(p => p.id === 'KAPC:I01LZ')!;
const santaRosa = data.approaches!.procedures.find(p => p.id === 'KSTS:I32')!;

test('O69 FA missed climb starts at the MAP and connects to PYE without duplicating the runway', () => {
  for (const procedure of data.approaches!.procedures.filter(p => p.airport === 'O69')) {
    for (const entry of approachEntryOptions(procedure)) assert.equal(approachPreview(procedure, entry.id)!.incomplete, false, entry.name);
  }
  for (const entry of approachEntryOptions(vor)) {
    const preview = approachPreview(vor, entry.id)!;
    const missed = preview.depictions.find(d => d.kind === 'missed')!;
    const map = preview.points[preview.landingEnd!]!, exit = preview.points[preview.exit!]!;
    assert.equal(map.ident, 'RW29');
    assert.equal(map.role, 'MAP');
    assert.equal(map.missed, undefined);
    assert.equal(exit.ident, 'PYE');
    assert.equal(exit.missed, true);
    assert.equal(preview.points.filter(p => p.ident === 'RW29').length, 1);
    assert.deepEqual(missed.coordinates[0], map.coordinate);
    assert.deepEqual(missed.coordinates.at(-1), exit.coordinate);
    assert.ok(missed.coordinates[1]![0] < map.coordinate[0] && missed.coordinates[1]![1] > map.coordinate[1], 'climb northwest before turning toward PYE');
    assert.ok(!preview.segments.some(s => s.phase === 'missed'));
  }
  const trailing = structuredClone(vor);
  trailing.final.pop();
  const preview = approachPreview(trailing, 'vectors')!;
  assert.equal(preview.incomplete, true);
  assert.equal(preview.exit, undefined);
  assert.equal(preview.points[preview.landingEnd!]!.ident, 'RW29');
  for (const missing of ['fix', 'magneticCourse'] as const) {
    const changed = structuredClone(vor);
    delete changed.final.find(l => l.path === 'FA')![missing];
    const invalid = approachPreview(changed, 'vectors')!;
    assert.equal(invalid.incomplete, true);
    assert.ok(!invalid.depictions.some(d => d.kind === 'missed'));
  }
});

test('Napa REBAS intercept joins the published inbound course in either phase, as a schematic', () => {
  for (const path of ['CI', 'VI']) for (const missed of [false, true]) {
    const procedure = structuredClone(napa);
    const legs = procedure.transitions.find(t => t.id === 'REBAS')!.legs;
    legs[1]!.path = path;
    if (missed) for (const leg of legs.slice(1)) leg.missed = true;
    const preview = approachPreview(procedure, 'transition:REBAS')!;
    assert.equal(preview.incomplete, false);
    const intercept = preview.depictions.find(d => d.kind === 'intercept')!;
    const coords = intercept.coordinates;
    assert.equal(intercept.phase, missed ? 'missed' : 'approach');
    assert.deepEqual(coords[0], legs[0]!.fix!.coordinate);
    assert.deepEqual(coords.at(-1), legs[2]!.fix!.coordinate);
    assert.ok(coords[1]![0] < coords[0]![0] && coords[1]![1] > coords[0]![1], 'depart REBAS northwest');
    assert.ok(coords.at(-2)![0] < coords.at(-1)![0] && coords.at(-2)![1] < coords.at(-1)![1], 'arrive at FESAV northeastbound');
    assert.ok(!preview.segments.some(s => s.from === 0));
  }
});

test('intercepts preserve gaps when unbounded, interrupted or missing a course', () => {
  const changes: [string, (p: ApproachRoute) => void][] = [
    ['heading', p => { delete p.transitions[0]!.legs[1]!.magneticCourse; }],
    ['inbound', p => { delete p.transitions[0]!.legs[2]!.magneticCourse; }],
    ['variation', p => { delete p.magneticVariation; }],
    ['manual vector', p => { p.transitions[0]!.legs[1]!.path = 'VM'; }],
    ['direct fix', p => { p.transitions[0]!.legs[2]!.path = 'DF'; }],
    ['phase change', p => { p.transitions[0]!.legs[2]!.missed = true; }],
    ['duplicate intercept', p => { p.transitions[0]!.legs.splice(2, 0, { path: 'VI', trueCourse: 340 }); }],
    ['trailing intercept', p => { p.transitions[0]!.legs.pop(); }],
    ['backwards heading', p => { p.transitions[0]!.legs[1]!.magneticCourse = 140.7; }],
  ];
  for (const [name, change] of changes) {
    const procedure = structuredClone(napa); change(procedure);
    const preview = approachPreview(procedure, 'transition:REBAS')!;
    assert.equal(preview.incomplete, true, name);
    assert.ok(!preview.depictions.some(d => d.kind === 'intercept'), name);
  }
});

test('Santa Rosa FC/CF connections preserve course distance and surveyed fixes', () => {
  for (const id of ['PYE', 'SGD']) {
    const preview = approachPreview(santaRosa, `transition:${id}`)!;
    const fc = santaRosa.transitions.find(t => t.id === id)!.legs.find(l => l.path === 'FC')!;
    const segment = preview.segments.find(s => preview.points[s.from]!.ident === fc.fix!.ident)!;
    assert.equal(preview.incomplete, false);
    assert.equal(preview.points[segment.to]!.ident, 'LUSEE');
    assert.equal(segment.coordinates.length, 3);
    assert.ok(Math.abs(distanceNm(segment.coordinates[0]!, segment.coordinates[1]!) - fc.distance!) < 1e-8);
    assert.deepEqual(segment.coordinates[0], fc.fix!.coordinate);
    assert.deepEqual(segment.coordinates.at(-1), preview.points[segment.to]!.coordinate);
    assert.equal(preview.points.filter(p => p.ident === fc.fix!.ident).length, 1);
  }
  for (const change of [{ distance: undefined }, { distance: 100 }, { magneticCourse: undefined }, { magneticCourse: 190 }]) {
    const procedure = structuredClone(santaRosa);
    Object.assign(procedure.transitions[0]!.legs[0]!, change);
    const preview = approachPreview(procedure, 'transition:PYE')!;
    assert.equal(preview.incomplete, true);
    assert.ok(!preview.segments.some(s => s.from === 0));
  }
  const reversed = structuredClone(santaRosa);
  for (const leg of reversed.transitions[0]!.legs) leg.magneticCourse = 190;
  assert.equal(approachPreview(reversed, 'transition:PYE')!.incomplete, true, 'matching courses must also agree with endpoint direction');
});

test('new connections reach the saved map and terrain; only fixed geometry contributes distance', () => {
  const cases = [
    [vor, 'VOR RWY 29', 'vectors', 'VTF', 'missed'],
    [napa, 'ILS Z OR LOC Z RWY 01L', 'transition:REBAS', 'REBAS', 'intercept'],
    [santaRosa, 'ILS OR LOC RWY 32', 'transition:PYE', 'PYE', undefined],
  ] as const;
  for (const [procedure, name, transitionId, entryName, kind] of cases) {
    const navigation: FeatureCollectionResponse = { type: 'FeatureCollection',
      meta: { layer: 'airports', revision: '2026-09-03', returned: 1, truncated: false }, features: [
        { type: 'Feature', id: procedure.airport, geometry: { type: 'Point', coordinates: procedure.final[0]!.fix!.coordinate },
          properties: { ident: procedure.airport } },
      ] };
    const selected: RouteApproach = { kind: 'approach' as const, source: 'chart' as const, airportId: procedure.airport, procedureId: procedure.id, name, cycle: '2609',
      entry: { routeId: procedure.id, transitionId, name: entryName, effectiveDate: '2026-09-03' } };
    const draft = routeDraftFromText(procedure.airport);
    const plan: RoutePlan = createRouteResolver([navigation], undefined, data)(setRouteApproach(draft, draft.entries[0]!, selected));
    assert.deepEqual(plan.issues, []);
    assert.equal(plan.distanceNm, plan.legs.reduce((sum, l) => sum + l.distanceNm, 0));
    assert.ok(routeSegments([plan]).length > routeSegments([{ ...plan, approachDepictions: [] }]).length);
    let source: FeatureCollection | undefined;
    syncRoute({ setGlobalStateProperty() {}, getSource: (id: string) => ({ setData(d: FeatureCollection) {
      if (id === ROUTE_SOURCE_ID) source = d;
    } }) } as unknown as MapLibreMap, plan);
    if (kind) {
      const depicted = source!.features.find(f => f.properties?.routeKind === `approach-${kind}`)!;
      assert.ok(depicted);
      assert.equal(depicted.properties!.editKind, undefined);
      assert.deepEqual(depicted.geometry, { type: 'LineString', coordinates: plan.approachDepictions!.find(d => d.kind === kind)!.coordinates });
    } else {
      const leg = plan.legs.find(l => l.from.ident === 'PYE')!;
      assert.ok(leg.distanceNm > 16 && leg.distanceNm < 17);
      assert.ok(source!.features.some(f => f.geometry.type === 'LineString' && JSON.stringify(f.geometry.coordinates) === JSON.stringify(leg.geometry)));
    }
  }
});
