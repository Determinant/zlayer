import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { isTerminalProceduresData, type ApproachRoute, type FeatureCollectionResponse, type TerminalProceduresData } from '@zlayer/contracts';
import { approachEntryOptions, approachIdent, approachPreview, createRouteResolver, distanceNm, routeCoordinateFeature, routeDraftFromText, type RouteApproach } from '@zlayer/domain';
import { syncRoute, ROUTE_SOURCE_ID } from '../src/layers/routes/renderer';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import { insertRouteFeature, sameRouteApproach, setRouteApproach } from '../src/layers/routes/draft';
import { removeRoutePoint } from '../src/layers/routes/removal';
import { directToRoutePoint } from '../src/layers/routes/direct-to';
import { corridorDistance, project, routeSegments } from '../src/layers/terrain/geometry';

const terminal: unknown = JSON.parse(readFileSync(new URL('./fixtures/route-approach-legs.json', import.meta.url), 'utf8'));
assert.ok(isTerminalProceduresData(terminal));
const approaches = terminal.approaches!;
const ils = approaches.procedures.find(p => p.id === 'KSFO:I28R')!;
const published: unknown = JSON.parse(readFileSync(new URL('./fixtures/route-approach-published.json', import.meta.url), 'utf8')).terminal;
assert.ok(isTerminalProceduresData(published));
const moffett: unknown = JSON.parse(readFileSync(new URL('./fixtures/route-approach-nuq.json', import.meta.url), 'utf8'));
assert.ok(isTerminalProceduresData(moffett));
const airports: FeatureCollectionResponse = { type: 'FeatureCollection', meta: { layer: 'airports', revision: '2026-09-03', returned: 3, truncated: false },
  features: [['KSFO', -122.375, 37.619], ['KSJC', -121.929, 37.362], ['KOAK', -122.221, 37.721]].map(([ident, lon, lat]) => ({
    type: 'Feature', id: String(ident), properties: { ident: String(ident) }, geometry: { type: 'Point', coordinates: [Number(lon), Number(lat)] },
  })) };
const selected: RouteApproach = { kind: 'approach' as const, source: 'chart' as const, airportId: 'KSFO', procedureId: 'ils', name: 'ILS OR LOC RWY 28R', cycle: '2609',
  entry: { routeId: ils.id, transitionId: 'transition:ARCHI', name: 'ARCHI', effectiveDate: '2026-09-03' } };
const resolve = createRouteResolver([airports], undefined, terminal);
function draft(approach = selected) {
  const route = routeDraftFromText('KSJC KSFO KOAK');
  return setRouteApproach(route, route.entries[1]!, approach);
}

test('published entries and VTF preserve runway suffixes and approach variants', () => {
  assert.equal(approachIdent('ILS Y RWY 31L'), 'I31LY');
  assert.equal(approachIdent('ILS Y RWY 31'), 'I31-Y');
  assert.equal(approachIdent('ILS OR LOC/DME RWY 24'), 'I24');
  assert.equal(approachIdent('ILS Z OR LOC Z RWY 13'), 'I13-Z');
  assert.equal(approachIdent('ILS Z OR LOC Z RWY 01L'), 'I01LZ');
  assert.equal(approachIdent('ILS Y OR LOC Z RWY 13'), undefined);
  assert.equal(approachIdent('HI-ILS OR LOC RWY 31'), undefined);
  assert.equal(approachIdent('VOR/DME RWY 31'), 'D31');
  assert.equal(approachIdent('GPS-A'), 'GPS-A');
  assert.equal(approachIdent('RNAV (RNP) Z RWY 4R'), 'H04RZ');
  assert.equal(approachIdent('ILS RWY 31 (CAT II)'), undefined);
  assert.deepEqual(approachEntryOptions(ils).map(e => e.name), ['ARCHI', 'DUMBA', 'EDDYY', 'SIDBY', 'VTF']);
  assert.equal(approachPreview(ils, 'transition:NOT-A-PUBLISHED-ENTRY'), undefined);
  const route = approachPreview(ils, 'transition:ARCHI')!;
  assert.deepEqual(route.points.map(p => p.ident), ['ARCHI', 'ZILED', 'GIRRR', 'DUMBA', 'CEPIN', 'AXMUL', 'RW28R', 'VIKYU']);
  assert.equal(route.incomplete, false);
  assert.equal(route.points.at(-1)?.hold, 'R');
});

test('uploaded branches use published fix names and expose IAFs within feeder routes', () => {
  const salinas = published.approaches!.procedures.find(p => p.id === 'KSNS:I31')!;
  assert.deepEqual(approachEntryOptions(salinas), [
    { id: 'transition:SNS1', name: 'SNS via AANNE', kind: 'fix' },
    { id: 'transition:SNS2', name: 'SNS via ARTYY', kind: 'fix' },
    { id: 'transition-fix:SNS1:2', name: 'AANNE', kind: 'fix' },
    { id: 'transition-fix:SNS2:1', name: 'ARTYY', kind: 'fix' },
    { id: 'vectors', name: 'VTF', kind: 'vectors' },
  ]);
  const direct = approachPreview(salinas, 'transition-fix:SNS1:2')!;
  assert.deepEqual(direct.points.map(p => p.ident), ['AANNE', 'FREZZ', 'DEBBS', 'RW31', 'MARNA']);
  assert.equal(direct.points[0]!.role, 'IAF');
  assert.equal(direct.points[0]!.hold, 'R');
  assert.equal(direct.points[direct.exit!]!.ident, 'MARNA');
  assert.equal(direct.points[direct.exit!]!.hold, 'R');
  assert.ok(!direct.segments.some(s => direct.points[s.from]!.ident === 'RW31' && direct.points[s.to]!.ident === 'MARNA'));
  assert.equal(approachPreview(salinas, 'transition-fix:SNS2:1')!.points[0]!.ident, 'ARTYY');
  assert.equal(approachPreview(salinas, 'transition-fix:SNS1:1'), undefined, 'only coded IAFs become internal entry choices');
});

test('entries preserve outbound course legs and discard the incoming arc at a selected IAF', () => {
  const atlantic = published.approaches!.procedures.find(p => p.id === 'KACY:I13-Z')!;
  assert.ok(approachEntryOptions(atlantic).some(entry => entry.name === 'VCN'));
  const outbound = approachPreview(atlantic, 'transition:VCN')!;
  assert.equal(outbound.incomplete, false);
  assert.deepEqual(outbound.points.slice(0, 2).map(p => p.ident), ['VCN', 'CARYL']);
  assert.ok(Math.abs(distanceNm(outbound.segments[0]!.coordinates[0]!, outbound.segments[0]!.coordinates[1]!) - 6.1) < 1e-8,
    'retain the outbound FC distance before the following CF');
  const missoula = published.approaches!.procedures.find(p => p.id === 'KMSO:H12-Z')!;
  const options = approachEntryOptions(missoula).filter(entry => entry.name.startsWith('NABNE'));
  assert.equal(options.length, 1, 'equivalent IAF suffixes deduplicate independently of the incoming leg');
  const preview = approachPreview(missoula, options[0]!.id)!;
  assert.equal(preview.points[0]!.ident, 'NABNE');
  assert.equal(preview.points[1]!.ident, 'FERSI');
  assert.deepEqual(preview.segments[0]!.coordinates, [preview.points[0]!.coordinate, preview.points[1]!.coordinate]);
});

test('KSNS ARTYY follows the published 22-DME arc through preview, route, map and terrain', () => {
  const salinas = published.approaches!.procedures.find(p => p.id === 'KSNS:I31')!;
  const coded = salinas.transitions.find(t => t.id === 'SNS2')!.legs.find(leg => leg.path === 'AF')!;
  const preview = approachPreview(salinas, 'transition-fix:SNS2:1')!;
  const arc = preview.segments[0]!;
  assert.deepEqual(preview.points.slice(0, 3).map(p => p.ident), ['ARTYY', 'AANNE', 'FREZZ']);
  assert.equal(preview.points.filter(p => p.ident === 'AANNE').length, 1);
  assert.deepEqual(arc.coordinates[0], preview.points[0]!.coordinate);
  assert.deepEqual(arc.coordinates.at(-1), preview.points[1]!.coordinate);
  assert.ok(arc.coordinates.length > 4);
  for (const point of arc.coordinates.slice(1, -1)) {
    assert.ok(Math.abs(distanceNm(coded.center!, point) - 22) < 1e-8);
  }
  assert.ok(arc.coordinates.every((p, i) => !i || p[0] < arc.coordinates[i - 1]![0] && p[1] < arc.coordinates[i - 1]![1]),
    'the right turn follows the short arc southwest from ARTYY');
  const feeder = approachPreview(salinas, 'transition:SNS2')!;
  assert.deepEqual(feeder.segments[1]!.coordinates, arc.coordinates);

  const selection: RouteApproach = { kind: 'approach' as const, source: 'chart' as const, airportId: 'KSNS', procedureId: 'ils31', name: 'ILS RWY 31', cycle: '2609',
    entry: { routeId: salinas.id, transitionId: 'transition-fix:SNS2:1', name: 'ARTYY', effectiveDate: '2026-09-03' } };
  const salinasAirports: FeatureCollectionResponse = { ...airports, features: [...airports.features,
    { type: 'Feature', id: 'KSNS', properties: { ident: 'KSNS' }, geometry: { type: 'Point', coordinates: [-121.606, 36.663] } }] };
  const original = routeDraftFromText('KSNS KOAK');
  const plan = createRouteResolver([salinasAirports], undefined, published)(setRouteApproach(original, original.entries[0]!, selection));
  const leg = plan.legs.find(l => l.from.ident === 'ARTYY' && l.to.ident === 'AANNE')!;
  assert.deepEqual(leg.geometry, arc.coordinates);
  assert.ok(leg.distanceNm > 9 && leg.distanceNm < 10);
  assert.ok(plan.legs.some(l => l.from.ident === 'MARNA' && l.to.ident === 'KOAK'));
  let source: FeatureCollection | undefined;
  syncRoute({ setGlobalStateProperty() {}, getSource: (id: string) => ({ setData(data: FeatureCollection) { if (id === ROUTE_SOURCE_ID) source = data; } }) } as unknown as MapLibreMap, plan);
  assert.ok(source!.features.some(f => f.geometry.type === 'LineString' && JSON.stringify(f.geometry.coordinates) === JSON.stringify(arc.coordinates)));
  const midpoint = project(arc.coordinates[Math.floor(arc.coordinates.length / 2)]!);
  assert.equal(corridorDistance(midpoint, routeSegments([{ ...plan, legs: [leg] }])), 0);
  const chord = { ...leg }; delete chord.geometry;
  assert.ok(corridorDistance(midpoint, routeSegments([{ ...plan, legs: [chord] }])) > 0.25, 'the curve is over a quarter NM from its chord');
});

test('AF arcs require valid published geometry and support either turn direction', () => {
  const salinas = published.approaches!.procedures.find(p => p.id === 'KSNS:I31')!;
  for (const missing of [{ center: undefined }, { radiusNm: undefined }, { turn: undefined }, { radiusNm: 15 }]) {
    const procedure = structuredClone(salinas);
    Object.assign(procedure.transitions.find(t => t.id === 'SNS2')!.legs.find(l => l.path === 'AF')!, missing);
    const preview = approachPreview(procedure, 'transition-fix:SNS2:1')!;
    assert.ok(!preview.segments.some(s => preview.points[s.from]!.ident === 'ARTYY'));
    assert.ok(preview.segments.some(s => preview.points[s.from]!.ident === 'AANNE' && preview.points[s.to]!.ident === 'FREZZ'));
    assert.equal(preview.incomplete, true);
  }
  const branch = salinas.transitions.find(t => t.id === 'SNS2')!.legs;
  const start = branch[1]!.fix!, end = branch[2]!.fix!;
  const reverse: ApproachRoute = { id: 'TEST:I31', airport: 'TEST', ident: 'I31', transitions: [], final: [
    { path: 'IF', fix: { ...end, role: 'IAF' } },
    { ...branch[2]!, fix: start, turn: 'L' },
  ] };
  const forwardArc = approachPreview(salinas, 'transition-fix:SNS2:1')!.segments[0]!.coordinates;
  const reverseArc = approachPreview(reverse, 'final:0')!.segments[0]!.coordinates.slice().reverse();
  assert.equal(reverseArc.length, forwardArc.length);
  reverseArc.forEach((point, i) => assert.ok(distanceNm(point, forwardArc[i]!) < 1e-8));
});

test('approach connections enter the selected fix and continue from the missed holding fix', () => {
  const plan = resolve(draft());
  assert.deepEqual(plan.issues, []);
  assert.ok(plan.legs.some(leg => leg.from.ident === 'KSJC' && leg.to.ident === 'ARCHI'));
  assert.ok(plan.legs.some(leg => leg.from.ident === 'VIKYU' && leg.to.ident === 'KOAK'));
  assert.ok(!plan.legs.some(leg => leg.from.ident === 'KSFO' || leg.to.ident === 'KSFO'));
  assert.equal(plan.legs.filter(leg => leg.approachPhase === 'missed').length, 1);
  assert.ok(plan.waypoints.find(p => p.ident === 'KSFO')?.edit, 'airport remains editable');
  assert.ok(plan.waypoints.filter(p => p.owners.some(o => o.kind === 'approach')).every(p => !p.edit));
  assert.deepEqual(plan.legs.map(leg => leg.from.ident), ['KSJC', 'ARCHI', 'ZILED', 'GIRRR', 'DUMBA', 'CEPIN', 'AXMUL', 'RW28R', 'VIKYU']);
});

test('approach connectors insert before and after the airport bundle without editing its published legs', () => {
  const original = draft(), plan = resolve(original);
  const waypoint = routeCoordinateFeature([-122, 37.5]);
  for (const [from, to, entryIndex] of [['KSJC', 'ARCHI', 0], ['VIKYU', 'KOAK', 1]] as const) {
    const connector = plan.legs.find(leg => leg.from.ident === from && leg.to.ident === to)!;
    assert.deepEqual(connector.edit, { kind: 'leg', afterEntryId: original.entries[entryIndex]!.id });
    const next = insertRouteFeature(original, connector.edit!.afterEntryId, waypoint);
    assert.equal(next.entries[entryIndex + 1]!.text, waypoint.properties.ident);
    assert.equal(next.entries.find(entry => entry.id === original.entries[1]!.id), original.entries[1]);
    const updated = resolve(next);
    assert.deepEqual(updated.issues, []);
    assert.ok(updated.legs.some(leg => leg.from.ident === from && leg.to.ident === waypoint.properties.ident));
    assert.ok(updated.legs.some(leg => leg.from.ident === waypoint.properties.ident && leg.to.ident === to));
    assert.deepEqual(updated.legs.filter(leg => leg.approachPhase).map(leg => [leg.from.ident, leg.to.ident, leg.geometry]),
      plan.legs.filter(leg => leg.approachPhase).map(leg => [leg.from.ident, leg.to.ident, leg.geometry]));
    assert.ok(updated.legs.filter(leg => leg.approachPhase).every(leg => !leg.edit));
  }
});

test('VTF connects the preceding waypoint to the FAF for map and terrain planning', () => {
  const selection = { ...selected, entry: { ...selected.entry!, transitionId: 'vectors', name: 'VTF' } };
  const plan = resolve(draft(selection));
  assert.equal(plan.approachExtensions?.length, 1);
  assert.deepEqual(plan.waypoints.filter(p => p.owners.length).map(p => p.ident), ['AXMUL', 'RW28R', 'VIKYU']);
  assert.ok(!plan.legs.some(leg => leg.from.ident === 'KSJC'));
  assert.deepEqual(plan.planningConnections?.map(c => [c.from.ident, c.to.ident]), [['KSJC', 'AXMUL']]);
  const { from, to } = plan.planningConnections![0]!;
  const a = project(from.feature.geometry.coordinates), b = project(to.feature.geometry.coordinates);
  assert.ok(corridorDistance([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], routeSegments([plan])) < 1e-8);
  assert.equal(plan.legs.find(leg => leg.from.ident === 'VIKYU' && leg.to.ident === 'KOAK')?.edit?.afterEntryId, plan.entries[1]!.id);
  assert.equal(sameRouteApproach(selected, selection), false);
});

test('consecutive approaches preserve the previous missed endpoint as the next preview arrival', () => {
  const original = routeDraftFromText('KSJC KSFO KSFO');
  const first = setRouteApproach(original, original.entries[1]!, selected);
  const both = setRouteApproach(first, first.entries[2]!, { ...selected, entry: { ...selected.entry!, transitionId: 'vectors', name: 'VTF' } });
  const plan = resolve(both);
  const previousExit = plan.waypoints.find(p => p.ident === 'VIKYU')!;
  const nextAirport = plan.waypoints.find(p => p.edit?.entryId === both.entries[2]!.id)!;
  assert.deepEqual(nextAirport.approachArrival?.coordinate, previousExit.feature.geometry.coordinates);
  assert.ok(!plan.legs.some(leg => leg.from === previousExit), 'VTF retains arrival context without a fabricated connector');
  assert.deepEqual(plan.planningConnections?.map(c => [c.from.ident, c.to.ident]), [['VIKYU', 'AXMUL']],
    'connect consecutive approaches without routing back through either airport marker');
  const connected = resolve(setRouteApproach(both, both.entries[2]!, selected));
  const connector = connected.legs.find(leg => leg.from.ident === 'VIKYU' && leg.to.ident === 'ARCHI')!;
  assert.equal(connector.edit?.afterEntryId, first.entries[1]!.id);
  const coordinate = routeCoordinateFeature([-122, 37.5]);
  const inserted = insertRouteFeature(connected, connector.edit!.afterEntryId, coordinate);
  assert.equal(inserted.entries[2]!.text, coordinate.properties.ident);
  assert.equal(inserted.entries[1], connected.entries[1]);
  assert.equal(inserted.entries[3], connected.entries[2]);
  assert.ok(resolve(inserted).legs.some(leg => leg.from.ident === coordinate.properties.ident && leg.to.ident === 'ARCHI'));
});

test('altitude depictions stay out of route legs; stale or absent editions never silently select an entry', () => {
  const rnav = approaches.procedures.find(p => p.id === 'KSFO:R28L')!;
  const preview = approachPreview(rnav, 'transition:ARCHI')!;
  assert.equal(preview.incomplete, false);
  assert.ok(preview.depictions.some(d => d.kind === 'missed'));
  assert.ok(!preview.segments.some(s => preview.points[s.from]!.ident === 'RW28L' && preview.points[s.to]!.ident === 'OLYMM'));
  assert.equal(preview.points.at(-1)?.ident, 'OLYMM');
  assert.equal(preview.points.at(-1)?.hold, 'L');
  for (const approach of [selected, { ...selected, entry: { ...selected.entry!, effectiveDate: '2026-08-06' } }]) {
    const plan = approach === selected ? createRouteResolver([airports])(draft(approach)) : resolve(draft(approach));
    assert.equal(plan.legs.length, 0);
    assert.equal(plan.issues[0]?.code, 'approach-unavailable');
  }
});

test('missed approach and hold depictions cover terrain without adding route distance', () => {
  const salinas = published.approaches!.procedures.find(p => p.id === 'KSNS:I31')!;
  const preview = approachPreview(salinas, 'transition-fix:SNS1:2')!;
  assert.equal(preview.incomplete, false);
  assert.deepEqual(preview.depictions.map(d => [d.kind, d.phase]), [['hold', 'approach'], ['missed', 'missed'], ['hold', 'missed']]);
  const missed = preview.depictions.find(d => d.kind === 'missed')!;
  const map = preview.points.find(p => p.role === 'MAP')!, mahf = preview.points[preview.exit!]!;
  assert.deepEqual(missed.coordinates[0], map.coordinate);
  assert.deepEqual(missed.coordinates.at(-1), mahf.coordinate);
  assert.equal(mahf.ident, 'MARNA');
  assert.equal(mahf.holdLength, '1 MIN');
  assert.ok(missed.coordinates[1]![0] < map.coordinate[0] && missed.coordinates[1]![1] > map.coordinate[1], 'initial climb follows the coded northwest course');
  assert.ok(missed.coordinates.length > 3, 'the missed path includes a sampled turn');
  assert.ok(preview.spans.some(s => s.assumptions.includes('altitude-dependent') && s.assumptions.includes('turn-radius')));
  assert.ok(!preview.segments.some(s => preview.points[s.from]!.ident === 'RW31'));
  const art = approachPreview(salinas, 'transition-fix:SNS2:1')!;
  assert.equal(art.depictions.filter(d => d.kind === 'hold').length, 1, 'ARTYY NoPT entry does not acquire the AANNE hold');

  const plan = resolve(draft());
  let source: FeatureCollection | undefined;
  syncRoute({ setGlobalStateProperty() {}, getSource: (id: string) => ({ setData(data: FeatureCollection) { if (id === ROUTE_SOURCE_ID) source = data; } }) } as unknown as MapLibreMap, plan);
  const hold = source!.features.find(f => f.properties?.routeKind === 'approach-hold')!;
  assert.equal(hold.properties!.approachPhase, 'missed');
  assert.equal(hold.properties!.editKind, undefined);
  assert.equal(hold.geometry.type, 'LineString');
  const arrows = source!.features.filter(f => f.properties?.routeKind === 'hold-direction');
  assert.equal(arrows.length, plan.approachDepictions!.filter(d => d.kind === 'hold').length, 'one arrow per racetrack');
  assert.ok(arrows.every(f => f.geometry.type === 'Point' && typeof f.properties!.holdBearing === 'number' && f.properties!.editKind === undefined));
  assert.deepEqual(plan.planningConnections, [], 'existing schematic connections do not acquire straight chords');
  for (const depiction of plan.approachDepictions!) for (const point of depiction.coordinates) {
    assert.equal(corridorDistance(project(point), routeSegments([plan])), 0);
  }
  assert.equal(plan.distanceNm, plan.legs.reduce((sum, leg) => sum + leg.distanceNm, 0));
});

test('KNUQ ILS 32R connects its climb and heading intercept to OAK in previews and the saved map', () => {
  const procedure = moffett.approaches!.procedures[0]!;
  for (const entry of approachEntryOptions(procedure)) {
    const preview = approachPreview(procedure, entry.id)!;
    assert.equal(preview.incomplete, false, entry.name);
    assert.deepEqual(preview.depictions.map(d => d.kind), ['missed', 'hold']);
    const missed = preview.depictions[0]!.coordinates;
    const map = preview.points.find(p => p.role === 'MAP')!, oak = preview.points[preview.exit!]!;
    assert.equal(oak.ident, 'OAK');
    assert.deepEqual(missed[0], map.coordinate);
    assert.deepEqual(missed.at(-1), oak.coordinate);
    assert.ok(!preview.segments.some(s => s.phase === 'missed'), 'the altitude-dependent connection stays schematic');
  }
  const selection: RouteApproach = { kind: 'approach' as const, source: 'chart' as const, airportId: 'KNUQ', procedureId: 'ils32r', name: 'ILS OR LOC RWY 32R', cycle: '2609',
    entry: { routeId: procedure.id, transitionId: 'vectors', name: 'VTF', effectiveDate: '2026-09-03' } };
  const navigation: FeatureCollectionResponse = { ...airports, features: [
    { type: 'Feature', id: 'KNUQ', properties: { ident: 'KNUQ' }, geometry: { type: 'Point', coordinates: [-122.049, 37.416] } }] };
  const original = routeDraftFromText('KNUQ');
  const plan = createRouteResolver([navigation], undefined, moffett)(setRouteApproach(original, original.entries[0]!, selection));
  assert.equal(plan.issues.length, 0);
  assert.equal(plan.legs.length, 1, 'only FAF to MAP contributes to route distance');
  assert.equal(plan.distanceNm, plan.legs[0]!.distanceNm);
  assert.ok(routeSegments([plan]).length > routeSegments([{ ...plan, approachDepictions: [] }]).length);
  let source: FeatureCollection | undefined;
  syncRoute({ setGlobalStateProperty() {}, getSource: (id: string) => ({ setData(data: FeatureCollection) { if (id === ROUTE_SOURCE_ID) source = data; } }) } as unknown as MapLibreMap, plan);
  const missed = source!.features.find(f => f.properties?.routeKind === 'approach-missed')!;
  assert.equal(missed.properties!.approachPhase, 'missed');
  assert.deepEqual(missed.geometry, { type: 'LineString', coordinates: approachPreview(procedure, 'vectors')!.depictions[0]!.coordinates });
});

test('missed intercepts require a known heading and a following coded inbound course', () => {
  const procedure = moffett.approaches!.procedures[0]!;
  for (const path of ['VI', 'CI']) {
    const supported = structuredClone(procedure);
    const intercept = supported.final.find(l => l.path === 'VI')!;
    intercept.path = path;
    intercept.trueCourse = 326;
    delete intercept.magneticCourse;
    assert.equal(approachPreview(supported, 'vectors')!.incomplete, false);
    assert.deepEqual(approachPreview(supported, 'vectors')!.depictions, approachPreview(procedure, 'vectors')!.depictions);
  }
  const invalid: [string, (p: ApproachRoute) => void][] = [
    ['missing intercept course', p => { delete p.final.find(l => l.path === 'VI')!.magneticCourse; }],
    ['missing inbound course', p => { delete p.final.find(l => l.path === 'CF' && l.missed)!.magneticCourse; }],
    ['missing variation', p => { delete p.magneticVariation; }],
    ['manual vector', p => { p.final.find(l => l.path === 'VI')!.path = 'VM'; }],
    ['no following inbound course', p => { p.final.find(l => l.path === 'CF' && l.missed)!.path = 'DF'; }],
    ['interrupted missed sequence', p => { p.final.find(l => l.path === 'CF' && l.missed)!.missed = false; }],
    ['repeated intercept', p => { p.final.splice(p.final.findIndex(l => l.path === 'VI'), 0, { path: 'VI', trueCourse: 310, missed: true }); }],
    ['trailing intercept', p => { p.final.splice(p.final.findIndex(l => l.path === 'VI') + 1); }],
  ];
  for (const [name, change] of invalid) {
    const unsupported = structuredClone(procedure); change(unsupported);
    const preview = approachPreview(unsupported, 'vectors')!;
    const missed = preview.spans.filter(s => s.symbol === 'missed');
    assert.ok(missed.every(s => s.to === undefined && s.assumptions.includes('open-termination')), name);
    assert.ok(preview.spans.some(s => s.kind === 'gap'), name);
    assert.equal(preview.incomplete, true, name);
    if (name === 'trailing intercept') assert.equal(preview.exit, undefined);
  }
});

test('holding symbols honor inbound course, turn side, distance and true-course coding', () => {
  for (const turn of ['L', 'R'] as const) {
    const procedure: ApproachRoute = { id: 'TEST:R01', airport: 'TEST', ident: 'R01', magneticVariation: 20, transitions: [], final: [
      { path: 'IF', fix: { ident: 'HOLD', coordinate: [0, 0], role: 'IAF' } },
      { path: 'HF', fix: { ident: 'HOLD', coordinate: [0, 0] }, trueCourse: 90, distance: 4, turn },
    ] };
    const preview = approachPreview(procedure, 'final:0')!;
    const hold = preview.depictions[0]!.coordinates;
    const arrow = preview.depictions[0]!.arrow!;
    assert.ok(Math.abs(arrow.bearing - 270) < .01, 'the arrow points west along the outbound leg');
    assert.ok(arrow.coordinate[0] < 0 && (turn === 'R' ? arrow.coordinate[1] < 0 : arrow.coordinate[1] > 0));
    assert.deepEqual(hold[0], [0, 0]); assert.deepEqual(hold.at(-1), [0, 0]);
    assert.ok(hold.some(p => p[0] < -0.06), 'racetrack extends outbound west of the fix');
    assert.ok(hold.every(p => turn === 'R' ? p[1] < 1e-8 : p[1] > -1e-8), 'right turns hold south of an eastbound inbound course; left turns hold north');
    assert.ok(Math.abs(distanceNm(hold[24]!, hold[25]!) - 4) < .001);
    assert.equal(preview.points[0]!.holdLength, '4 NM');
    assert.equal(preview.segments.length, 0);
    procedure.final[1]!.magneticCourse = 70; delete procedure.final[1]!.trueCourse;
    assert.deepEqual(approachPreview(procedure, 'final:0')!.depictions[0]!.coordinates, hold, 'airport variation converts magnetic to true');
  }
});

test('missing hold data and open-ended vectors do not fabricate patterns or missed connectors', () => {
  const salinas = published.approaches!.procedures.find(p => p.id === 'KSNS:I31')!;
  for (const missing of ['magneticVariation', 'holdMinutes', 'turn'] as const) {
    const procedure = structuredClone(salinas);
    if (missing === 'magneticVariation') delete procedure.magneticVariation;
    else delete procedure.final.at(-1)![missing];
    const preview = approachPreview(procedure, 'vectors')!;
    assert.equal(preview.depictions.filter(d => d.kind === 'hold').length, 0);
    assert.equal(preview.incomplete, true);
    if (missing === 'turn') assert.equal(preview.points.at(-1)!.hold, 'unknown');
  }
  for (const path of ['VM', 'FM', 'XX']) {
    const procedure = structuredClone(salinas);
    procedure.final.find(l => l.path === 'CA')!.path = path;
    const preview = approachPreview(procedure, 'vectors')!;
    assert.equal(preview.depictions.filter(d => d.kind === 'missed').length, 0);
    assert.equal(preview.incomplete, true);
  }
  const trailing = structuredClone(salinas);
  trailing.final.splice(trailing.final.findIndex(l => l.path === 'CA') + 1);
  assert.equal(approachPreview(trailing, 'vectors')!.exit, undefined);
});

test('schematic missed turns honor an explicit long turn and retain their published endpoint', () => {
  for (const turn of ['L', 'R'] as const) {
    const procedure: ApproachRoute = { id: 'TEST:R01', airport: 'TEST', ident: 'R01', transitions: [], final: [
      { path: 'IF', fix: { ident: 'START', coordinate: [0, 0], role: 'IAF' } },
      { path: 'CA', trueCourse: 0, missed: true },
      { path: 'CF', fix: { ident: 'END', coordinate: [.1, 0] }, trueCourse: 90, turn, missed: true },
    ] };
    const preview = approachPreview(procedure, 'final:0')!;
    const coordinates = preview.depictions[0]!.coordinates;
    assert.deepEqual(coordinates[0], [0, 0]); assert.deepEqual(coordinates.at(-1), [.1, 0]);
    assert.ok(coordinates[1]![1] > 0, 'the climb initially heads north');
    assert.equal(coordinates.some(p => p[0] < -0.001), turn === 'L', 'a left turn toward east must retain the long turn through the west');
    assert.equal(preview.segments.length, 0);
    assert.equal(preview.exit, 1);
  }
});

test('RF arcs use their coded center; unsupported legs and trailing vectors cannot invent an endpoint', () => {
  const procedure: ApproachRoute = { id: 'TEST:R01', airport: 'TEST', ident: 'R01', transitions: [], final: [
    { path: 'IF', fix: { ident: 'START', coordinate: [0, .1], role: 'IAF' } },
    { path: 'RF', fix: { ident: 'END', coordinate: [.1, 0] }, center: [0, 0], turn: 'R' },
    { path: 'VM' },
  ] };
  const preview = approachPreview(procedure, 'final:0')!;
  assert.ok(preview.segments[0]!.coordinates.length > 10);
  assert.equal(preview.incomplete, true);
  assert.equal(preview.exit, undefined);
  procedure.final.splice(1, 0, { path: 'FC', fix: { ident: 'START', coordinate: [0, .1] }, distance: 5 });
  assert.equal(approachPreview(procedure, 'final:0')!.segments.length, 0);
});

test('map source carries selected geometry, missed styling, VTF extension and fix roles', () => {
  const plan = resolve(draft({ ...selected, entry: { ...selected.entry!, transitionId: 'vectors', name: 'VTF' } }));
  let source: FeatureCollection | undefined;
  syncRoute({ setGlobalStateProperty() {}, getSource: (id: string) => ({ setData(data: FeatureCollection) { if (id === ROUTE_SOURCE_ID) source = data; } }) } as unknown as MapLibreMap, plan);
  assert.ok(source!.features.some(f => f.properties?.routeKind === 'approach-extension'));
  const connection = source!.features.find(f => f.properties?.routeKind === 'planning-connection')!;
  assert.deepEqual(connection.geometry, { type: 'LineString', coordinates: plan.planningConnections!.flatMap(c =>
    [c.from.feature.geometry.coordinates, c.to.feature.geometry.coordinates]) });
  assert.equal(connection.properties!.editKind, undefined);
  assert.ok(source!.features.some(f => f.properties?.approachPhase === 'missed'));
  assert.ok(source!.features.some(f => f.properties?.ident === 'AXMUL' && f.properties.approachRole === 'FAF'));
  assert.ok(source!.features.filter(f => f.properties?.approachPoint).every(f => f.properties?.editKind === undefined));
});

test('procedure children cannot be removed individually or resurrect stale selections; terrain follows curved geometry', () => {
  const original = draft(), plan = resolve(original);
  const child = plan.waypoints.find(point => point.ident === 'ARCHI')!;
  assert.equal(removeRoutePoint(original, plan, child), original);
  const changed = setRouteApproach(original, original.entries[1]!, { ...selected, entry: { ...selected.entry!, transitionId: 'vectors', name: 'VTF' } });
  assert.equal(directToRoutePoint(changed, plan, child, [-122, 37]), changed);
  assert.equal(removeRoutePoint(changed, plan, plan.waypoints.find(point => point.ident === 'KSFO')!), changed);
  const curved = { ...plan, legs: [{ ...plan.legs[0]!, geometry: [[0, .1], [.07, .07], [.1, 0]] as [number, number][] }] };
  assert.equal(corridorDistance(project([.07, .07]), routeSegments([curved])), 0, 'terrain samples the displayed bend, not the endpoint chord');
});

test('malformed geometry and wrong editions are rejected at the shared offline/cache boundary', () => {
  assert.equal(isTerminalProceduresData({ ...terminal, approaches: { ...approaches, metadata: { ...approaches.metadata, effectiveDate: '2026-08-06' } } }), false);
  const broken = structuredClone(terminal);
  broken.approaches!.procedures[0]!.final[0]!.fix!.coordinate = [Infinity, 34];
  assert.equal(isTerminalProceduresData(broken), false);
  for (const radiusNm of [0, -22, Infinity, NaN, '22']) {
    const invalid: TerminalProceduresData = structuredClone(terminal);
    Object.assign(invalid.approaches!.procedures[0]!.final[0]!, { radiusNm });
    assert.equal(isTerminalProceduresData(invalid), false);
  }
  for (const fields of [{ holdMinutes: 0 }, { holdMinutes: Infinity }, { trueCourse: 360 }, { trueCourse: 90, magneticCourse: 80 }]) {
    const invalid: TerminalProceduresData = structuredClone(terminal);
    Object.assign(invalid.approaches!.procedures[0]!.final[0]!, fields);
    assert.equal(isTerminalProceduresData(invalid), false);
  }
  const invalidVariation: TerminalProceduresData = structuredClone(terminal);
  invalidVariation.approaches!.procedures[0]!.magneticVariation = NaN;
  assert.equal(isTerminalProceduresData(invalidVariation), false);
});
