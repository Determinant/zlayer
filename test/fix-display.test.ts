import assert from 'node:assert/strict';
import test from 'node:test';
import type { AirwayDataResponse, AirwayRecord, FeatureCollectionResponse, GeoPointFeature } from '@zlayer/contracts';
import { createRouteResolver, searchNavigation } from '@zlayer/domain';
import { DEFAULT_FIX_DISPLAY, fixDisplayData, indexFixDisplay, priorityFixData } from '../src/layers/navigation/fix-display';

function fix(ident: string, charts?: unknown, extra: Record<string, unknown> = {}): GeoPointFeature {
  return { type: 'Feature', id: `fix:${ident}`, geometry: { type: 'Point', coordinates: [-122, 37] },
    properties: { kind: 'fix', ident, charts, country: 'US', state: 'CA', icaoRegion: 'K2', ...extra } };
}
function collection(features: GeoPointFeature[]): FeatureCollectionResponse {
  return { type: 'FeatureCollection', features,
    meta: { layer: 'fixes', revision: 'test', returned: features.length, truncated: false } };
}
function airway(ident: string, points: string[], extra: Partial<AirwayRecord> = {}): AirwayRecord {
  return { id: `airway:${ident}`, ident, points, regulatory: true,
    segments: points.map((from, sequence) => ({ from, sequence, gap: false, fromType: 'RP', country: 'US', state: 'CA', icaoRegion: 'K2' })), ...extra };
}
function airways(...records: AirwayRecord[]): AirwayDataResponse {
  return { type: 'ZLayerAirways', metadata: { effectiveDate: 'test', source: 'fixture' }, airways: records };
}
const names = (data: FeatureCollectionResponse) => data.features.map(feature => feature.properties.ident);

test('chart role gates eligibility even at maximum zoom; mixed IAP/enroute fixes remain eligible', () => {
  const raw = collection([
    fix('LOW', ['ENROUTE LOW', 'IAP']), fix('HIGH', ['ENROUTE HIGH']), fix('AREA', ['AREA']),
    fix('OCEAN', ['NORTH PACIFIC ROUTE']), fix('ARRIV', ['STAR', 'IAP']), fix('DEPAR', ['SID']),
    fix('APPR', ['IAP']), fix('MILAP', ['MILITARY IAP']), fix('PRIV', ['PRIVATE IAP']),
    fix('SPECIAL', ['SPECIAL IAP']), fix('UNKNOWN'), fix('BROKEN', 42),
    fix('VPONE', ['SECTIONAL'], { kind: 'vfr-waypoint' }),
  ]);
  const before = JSON.stringify(raw);
  const index = indexFixDisplay(raw);
  assert.deepEqual(names(fixDisplayData(index, DEFAULT_FIX_DISPLAY)), ['AREA', 'LOW', 'OCEAN']);
  assert.deepEqual(names(fixDisplayData(index, { detail: 'enroute', airspace: 'high' })), ['HIGH', 'OCEAN']);
  assert.deepEqual(names(fixDisplayData(index, { detail: 'enroute', airspace: 'both' })), ['AREA', 'HIGH', 'LOW', 'OCEAN']);
  const terminal = fixDisplayData(index, { detail: 'terminal', airspace: 'low' });
  assert.deepEqual(names(terminal), ['AREA', 'LOW', 'OCEAN', 'ARRIV', 'DEPAR']);
  assert.equal(terminal.features.at(-1)?.properties.mapFixMinZoom, 11);
  const all = fixDisplayData(index, { detail: 'all', airspace: 'low' });
  assert.equal(all.features.length, raw.features.length - 1, 'VFR waypoints retain their own layer');
  assert.equal(all.features.find(f => f.properties.ident === 'APPR')?.properties.mapFixMinZoom, 12);
  assert.equal(all.features.find(f => f.properties.ident === 'HIGH')?.properties.mapFixMinZoom, 10,
    'a lower-ranked co-located enroute fix waits for close-up collision placement');
  assert.equal(JSON.stringify(raw), before, 'rendering does not mutate search/route data');
});

test('distinct airway memberships rank junctions first without counting repeated segments or components twice', () => {
  const raw = collection([fix('OFF', ['ENROUTE LOW']), fix('SINGLE', ['IAP']), fix('JOIN', ['IAP']), fix('HIGH', ['IAP'])]);
  raw.features.forEach((feature, index) => { feature.geometry.coordinates[0] += index * 20; });
  const index = indexFixDisplay(raw, airways(
    airway('V1', ['JOIN', 'SINGLE', 'JOIN']), airway('V1', ['JOIN', 'SINGLE'], { id: 'other-component' }),
    airway('T2', ['JOIN']), airway('Q3', ['HIGH']), airway('V9', ['OFF'], { regulatory: false }),
  ));
  const result = fixDisplayData(index, DEFAULT_FIX_DISPLAY);
  assert.deepEqual(names(result), ['JOIN', 'SINGLE', 'OFF']);
  assert.deepEqual(result.features.map(f => f.properties.mapFixMinZoom), [6, 6, 6]);
  assert.deepEqual(result.features.map(f => f.properties.mapFixPriority), [0, 1, 2]);
  assert.deepEqual(names(fixDisplayData(index, { detail: 'enroute', airspace: 'high' })), ['HIGH']);
  const shuffled = indexFixDisplay(collection([...raw.features].reverse()), airways(airway('T2', ['JOIN']), airway('V1', ['SINGLE', 'JOIN'])));
  assert.deepEqual(names(fixDisplayData(shuffled, DEFAULT_FIX_DISPLAY)), names(result));
});

test('wide views retain the highest-ranked fix per area, adding detail without replacing earlier winners', () => {
  // Same zoom-6 cell; separate children at zoom 7. Names deliberately oppose rank.
  const top = fix('ZZTOP', ['ENROUTE LOW']);
  top.geometry.coordinates[0] = 360 * 20.125 / 256 - 180;
  const near = fix('AANEAR', ['ENROUTE LOW']);
  near.geometry.coordinates[0] = 360 * 20.625 / 256 - 180;
  const tied = { ...fix('ABTIE', ['ENROUTE LOW']), geometry: near.geometry };
  const distant = fix('FAR', ['ENROUTE LOW']);
  distant.geometry.coordinates[0] = 360 * 25.125 / 256 - 180;
  const raw = collection([tied, near, distant, top]);
  const routes = airways(airway('V1', names(raw) as string[]), airway('T2', names(raw) as string[]), airway('V3', ['ZZTOP']));
  const displayed = fixDisplayData(indexFixDisplay(raw, routes), DEFAULT_FIX_DISPLAY);
  const visible = (zoom: number) => names({ ...displayed,
    features: displayed.features.filter(f => Number(f.properties.mapFixMinZoom) <= zoom) });
  assert.deepEqual(visible(6), ['ZZTOP', 'FAR']);
  assert.deepEqual(visible(7), ['ZZTOP', 'AANEAR', 'FAR']);
  assert.deepEqual(visible(9), visible(7), 'coincident lower-ranked points wait for close-up collision placement');
  assert.deepEqual(visible(10), ['ZZTOP', 'AANEAR', 'ABTIE', 'FAR']);
  assert.deepEqual(fixDisplayData(indexFixDisplay(collection([...raw.features].reverse()), routes), DEFAULT_FIX_DISPLAY), displayed,
    'ranking and density do not depend on incoming record order');
  const selected = priorityFixData([tied]);
  assert.deepEqual(names(selected), ['ABTIE'], 'selection bypasses density');
  assert.ok(!names(fixDisplayData(indexFixDisplay(raw, routes), DEFAULT_FIX_DISPLAY, selected.features)).includes('ABTIE'));
});

test('density handles wrapped longitudes and polar coordinates without dropping eligible fixes', () => {
  const raw = collection([fix('EAST', ['ENROUTE LOW']), fix('WEST', ['ENROUTE LOW']), fix('NORTH', ['ENROUTE LOW']), fix('SOUTH', ['ENROUTE LOW'])]);
  raw.features.forEach((feature, index) => {
    feature.geometry.coordinates = [[180, 0], [-180, 0], [0, 90], [0, -90]][index] as [number, number];
  });
  const result = fixDisplayData(indexFixDisplay(raw), DEFAULT_FIX_DISPLAY);
  assert.deepEqual(result.features.map(f => [f.properties.ident, f.properties.mapFixMinZoom]),
    [['EAST', 6], ['NORTH', 6], ['SOUTH', 6], ['WEST', 10]]);
});

test('even without airway data, sparse enroute fixes are eligible in the first visible tile zoom', () => {
  const raw = collection([fix('AENRT', ['ENROUTE LOW']), fix('BENRT', ['ENROUTE LOW']), fix('TERM', ['STAR'])]);
  const result = fixDisplayData(indexFixDisplay(raw), { detail: 'terminal', airspace: 'low' });
  assert.deepEqual(result.features.map(f => [f.properties.ident, f.properties.mapFixMinZoom]),
    [['AENRT', 6], ['BENRT', 10], ['TERM', 11]]);
});

test('duplicate names and navaids do not falsely promote a procedure fix onto an airway', () => {
  const ca = fix('DUP', ['IAP']);
  const nv = { ...fix('DUP', ['IAP'], { state: 'NV' }), id: 'fix:DUP:NV' };
  const raw = collection([ca, nv, fix('VORID', ['IAP'])]);
  const data = airways(airway('V1', ['DUP']), airway('T2', ['DUP']),
    airway('V3', ['VORID'], { segments: [{ sequence: 0, from: 'VORID', gap: false, fromType: 'VOR/DME' }] }));
  const result = fixDisplayData(indexFixDisplay(raw, data), DEFAULT_FIX_DISPLAY);
  assert.deepEqual(result.features.map(f => f.id), [ca.id]);
  const ambiguous = airways(airway('V1', ['DUP'], { segments: [{ sequence: 0, from: 'DUP', gap: false, fromType: 'RP' }] }));
  assert.equal(fixDisplayData(indexFixDisplay(raw, ambiguous), DEFAULT_FIX_DISPLAY).features.length, 0);
});

test('hidden approach fixes remain searchable and routable; context is deduplicated by identity, not name', () => {
  const approach = fix('APPRO', ['IAP']);
  const elsewhere = { ...fix('APPRO', ['IAP']), id: 'fix:APPRO:elsewhere' };
  const raw = collection([approach, elsewhere, fix('ENRTE', ['ENROUTE LOW'])]);
  const plan = createRouteResolver([raw])('ENRTE APPRO', { 1: approach.id! });
  assert.equal(plan.issues.length, 0);
  assert.equal(searchNavigation([raw], 'APPRO')[0]?.feature.properties.ident, 'APPRO');
  const priority = priorityFixData([approach, ...plan.waypoints.map(w => w.feature), elsewhere]);
  assert.equal(priority.features.length, 3);
  assert.equal(priority.features[0]?.id, approach.id, 'selected fix retains first priority');
  assert.deepEqual(names(fixDisplayData(indexFixDisplay(raw), DEFAULT_FIX_DISPLAY, priority.features)), []);
  assert.deepEqual(names(fixDisplayData(indexFixDisplay(raw), DEFAULT_FIX_DISPLAY)), ['ENRTE'], 'clearing context restores background');
});

test('ID-less fixes keep their density ordering and distinct same-name selections', () => {
  const first = fix('DUP', ['ENROUTE LOW']);
  const second = fix('DUP', ['ENROUTE LOW']);
  delete first.id;
  delete second.id;
  second.geometry.coordinates = [-122, 37.1];
  const raw = collection([second, first]);
  const index = indexFixDisplay(raw);
  assert.deepEqual(fixDisplayData(index, DEFAULT_FIX_DISPLAY).features.map(feature => feature.geometry.coordinates),
    [first.geometry.coordinates, second.geometry.coordinates]);
  assert.deepEqual(priorityFixData([first, second, { ...first }]).features.map(feature => feature.geometry.coordinates),
    [first.geometry.coordinates, second.geometry.coordinates]);
  assert.deepEqual(fixDisplayData(index, DEFAULT_FIX_DISPLAY, [first]).features.map(feature => feature.geometry.coordinates),
    [second.geometry.coordinates]);
});

test('cached rankings preserve density when priority fixes enter, leave, or change order', () => {
  const raw = collection([fix('FIRST', ['ENROUTE LOW']), fix('SECOND', ['ENROUTE LOW']), fix('TERM', ['SID'])]);
  const index = indexFixDisplay(raw, airways(airway('V1', ['FIRST', 'SECOND']), airway('J1', ['SECOND'])));
  const render = (priority: GeoPointFeature[] = []) => fixDisplayData(index, DEFAULT_FIX_DISPLAY, priority);
  const original = render();
  assert.deepEqual(names(original), ['FIRST', 'SECOND']);
  assert.deepEqual(original.features.map(f => f.properties.mapFixMinZoom), [6, 10]);
  const promoted = render([raw.features[0]!]);
  assert.deepEqual(names(promoted), ['SECOND']);
  assert.equal(promoted.features[0]!.properties.mapFixMinZoom, 6, 'priority fixes free their former density cells');
  assert.equal(promoted.features[0]!.properties.mapFixPriority, 0, 'visible ordering remains contiguous');
  assert.deepEqual(render(), original);
  const both = fixDisplayData(index, { detail: 'enroute', airspace: 'both' });
  assert.deepEqual(names(both), ['SECOND', 'FIRST'], 'low and high memberships both contribute');
  assert.deepEqual(render(), original, 'switching settings cannot reuse the wrong ranking');
  assert.deepEqual(render(raw.features.slice(0, 2)), render(raw.features.slice(0, 2).reverse()));
});
