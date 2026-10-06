import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { distanceNm } from '@zlayer/domain';
import type { GeoPointFeature, NavigationData } from '@zlayer/contracts';
import { notamArea, notamAreaDefinition } from '../src/layers/notams/areas';
import { createNotamAreaReferences } from '../src/layers/notams/area-references';
import { chartedNotamPresentation, notamChartFeatures, notamChartKey } from '../src/layers/notams/chart';
import { NotamList } from '../src/layers/notams/ui';
import { notamBlockText, presentNotam } from '../src/layers/notams/presentation';
import { notice, NOTAM_NOW } from './fixtures/notams';
import { auditMappedNotam } from '../tools/audit-notams';

const station = (properties: GeoPointFeature['properties'] = {}): GeoPointFeature => ({ type: 'Feature', id: 'test-vor',
  geometry: { type: 'Point', coordinates: [-77, 39] }, properties: { kind: 'navaid', ident: 'TST', type: 'VOR/DME',
    stationDeclinationDeg: -10, status: 'OPERATIONAL IFR', ...properties } });
const navigation = (features: GeoPointFeature[], airports: GeoPointFeature[] = []): NavigationData => ({
  navaids: { type: 'FeatureCollection', features, meta: { revision: '2026-10-01', layer: 'navaids', returned: features.length, truncated: false } },
  airports: { type: 'FeatureCollection', features: airports, meta: { revision: '2026-10-01', layer: 'airports', returned: airports.length, truncated: false } },
});

const circle = 'AIRSPACE UAS WI AN AREA DEFINED AS 3.2NM RADIUS OF 325151.50N0970622W (4.0NM WSW DFW) SFC-400FT AGL';
const polygon = 'AIRSPACE UAS WI AN AREA DEFINED AS 373735N1222415W (1.4NM W SFO) TO 373736N1222410W (1.4NM W SFO) ' +
  'TO 373651N1222354W (1.1NM WSW SFO) TO 373648N1222358W (1.2NM WSW SFO) TO 373719N1222422W (1.5NM W SFO) ' +
  'TO 373724N1222413W (1.4NM W SFO) TO POINT OF ORIGIN SFC-25FT AGL';
// FAA AIM GPS-testing example; retains the stated altitude-dependent footprint.
const gps = 'NAV GPS (INCLUDING WAAS, GBAS, AND ADS-B) MAY NOT BE AVAILABLE WITHIN A 468NM RADIUS CENTERED AT ' +
  '330702N1062540W (TCS 093044) FL400-UNL DECREASING IN AREA WITH A DECREASE IN ALTITUDE DEFINED AS: ' +
  '425NM RADIUS AT FL250, 360NM RADIUS AT 10000FT, 354NM RADIUS AT 4000FT AGL, 327NM RADIUS AT 50FT AGL.';

test('published circle radius and DMS center generate bounded geodesic geometry', () => {
  const record = notice({ text: circle }), before = structuredClone(record), area = notamArea(record)!;
  assert.deepEqual(area.labelPosition, [-(97 + 6 / 60 + 22 / 3600), 32 + 51 / 60 + 51.5 / 3600]);
  assert.equal(area.label, 'UAS\nSFC-400FT AGL'); assert.equal(area.outer, false);
  assert.deepEqual(area.polygons[0]![0]![0], area.polygons[0]![0]!.at(-1));
  assert.ok(area.polygons[0]![0]!.length >= 65 && area.polygons[0]![0]!.length <= 721);
  for (const vertex of area.polygons[0]![0]!) assert.ok(Math.abs(distanceNm(area.labelPosition, vertex) - 3.2) < 1e-8);
  assert.equal(circle.slice(area.span.start, area.span.end), 'WI AN AREA DEFINED AS 3.2NM RADIUS OF 325151.50N0970622W (4.0NM WSW DFW)');
  assert.deepEqual(record, before);
  assert.ok(notamArea(notice({ text: circle.replace('3.2NM RADIUS OF', '.1NM RADIUS').replace('325151.50N0970622W', '325151.50S0970622E') })));
});

test('published closed polygon keeps its vertices and wraps across the dateline locally', () => {
  const area = notamArea(notice({ text: polygon }))!;
  assert.equal(area.label, 'UAS\nSFC-25FT AGL'); assert.equal(area.polygons[0]![0]!.length, 7);
  assert.ok(area.polygons[0]![0]!.some(([lon, lat]) => Math.abs(lon + 122 + 24 / 60 + 15 / 3600) < 1e-9 && Math.abs(lat - 37 - 37 / 60 - 35 / 3600) < 1e-9));
  const wrapped = notamArea(notice({ text: 'AIRSPACE UAS WI AN AREA DEFINED AS 100000N1795000E TO 100000N1795000W TO 110000N1795000W TO 110000N1795000E TO POINT OF ORIGIN SFC-400FT AGL' }))!;
  assert.ok(Math.max(...wrapped.polygons[0]![0]!.map(p => p[0])) - Math.min(...wrapped.polygons[0]![0]!.map(p => p[0])) < 1);
  assert.deepEqual(wrapped.polygons[0]![0]![0], wrapped.polygons[0]![0]!.at(-1));
});

test('supplied mixed-case Bull Fire boundary keeps four vertices, closes once and preserves dispatch instructions', () => {
  const text = 'WI an area defined as 393530N1195930W (FMG267016.0) to 393530N1195700W (FMG269014.1) to ' +
    '393030N1195730W (FMG248014.1) to 393000N1200100W (FMG248016.8) to 393530N1195930W (FMG267016.0) ' +
    'to point of origin SFC-10000FT SIERRA FRONT DISPATCH TEL 775-782-1401 or FREQ 118.425 BULL FIRE is in CHARGE of the OPERATION.';
  for (const prefix of ['', 'AIRSPACE FIRE FIGHTING ACFT OPS ']) {
    const record = notice({ text: prefix + text }), area = notamArea(record)!;
    assert.equal(area.polygons[0]![0]!.length, 5); assert.deepEqual(area.polygons[0]![0]![0], area.polygons[0]![0]!.at(-1));
    for (const point of [[-119.99166666666666, 39.59166666666667], [-119.95, 39.59166666666667],
      [-119.95833333333334, 39.50833333333333], [-120.01666666666667, 39.5]]) {
      assert.ok(area.polygons[0]![0]!.some(p => distanceNm(p, point as [number, number]) < 1e-8));
    }
    const reading = chartedNotamPresentation(record)!.presentation.searchText;
    for (const retained of ['SFC-10000FT', '775-782-1401', '118.425', 'BULL FIRE']) assert.ok(reading.includes(retained));
    assert.deepEqual(auditMappedNotam(record), []);
  }
  assert.equal(notamArea(notice({ text: 'AIRSPACE TFR ' + text })), undefined, 'TFRs remain owned by the persistent FAA layer');
});

test('minute coordinates and spelled-out nautical mile radius preserve source offsets and altitude', () => {
  const record = notice({ text: 'AIRSPACE UAS WITHIN A .5 NAUTICAL MILE RADIUS CENTERED ON 6459N14759W (FAI051007) SFC-100FT AGL TEL 907-217-6707' });
  const area = notamArea(record)!;
  assert.deepEqual(area.labelPosition, [-147 - 59 / 60, 64 + 59 / 60]);
  assert.ok(area.polygons[0]![0]!.every(point => Math.abs(distanceNm(area.labelPosition, point) - .5) < 1e-8));
  assert.equal(record.text.slice(area.span.start, area.span.end), 'WITHIN A .5 NAUTICAL MILE RADIUS CENTERED ON 6459N14759W (FAI051007)');
  assert.deepEqual(auditMappedNotam(record), []);
  assert.equal(notamArea(notice({ text: record.text.replace('6459N', '6460N') })), undefined);
});

test('VOR radial/distance circles use published station alignment and support fractional distances and slash notation', () => {
  const references = createNotamAreaReferences(navigation([station()]));
  for (const center of ['TST010015.4', 'TST 010015.4', 'TST/010/15.4']) {
    const record = notice({ text: `AIRSPACE PJE WI AN AREA DEFINED AS 2NM RADIUS OF ${center} SFC-6500FT` });
    assert.equal(notamArea(record), undefined);
    const area = notamArea(record, references)!;
    // 010 radial + -10 degree station alignment is due true north.
    assert.ok(Math.abs(area.labelPosition[0] + 77) < 1e-10);
    assert.ok(area.labelPosition[1] > 39);
    assert.ok(Math.abs(distanceNm([-77, 39], area.labelPosition) - 15.4) < 1e-8);
    assert.ok(area.polygons[0]![0]!.every(point => Math.abs(distanceNm(area.labelPosition, point) - 2) < 1e-8));
    assert.equal(notamChartFeatures([record], NOTAM_NOW, references).features.length, 2);
  }
});

test('reference polygons resolve every vertex and invalidate geometry when navigation context changes', () => {
  const record = notice({ text: 'AIRSPACE UAS WI AN AREA DEFINED AS TST010010 TO TST100010 TO TST190010 TO POINT OF ORIGIN SFC-400FT AGL' });
  const references = createNotamAreaReferences(navigation([station()]));
  const area = notamArea(record, references)!;
  assert.equal(area.polygons[0]![0]!.length, 4);
  assert.equal(notamArea(record, createNotamAreaReferences(navigation([]))), undefined);
  const changed = createNotamAreaReferences(navigation([station({ stationDeclinationDeg: 5 })]));
  assert.notDeepEqual(notamArea(record, changed)?.polygons, area.polygons);
  for (const text of [record.text.replace('TST100010', 'XXX100010'), record.text.replace('TST100010', 'TST361010'),
    record.text.replace('TST100010', 'TST100601'), record.text.replace('TO POINT OF ORIGIN', 'TO SOMEWHERE')]) {
    assert.equal(notamArea(notice({ text }), references), undefined);
  }
  const unaligned = station(); delete unaligned.properties.stationDeclinationDeg;
  for (const features of [[unaligned], [station(), { ...station(), id: 'duplicate' }],
    [station({ type: 'DME' })], [station({ status: 'DECOMMISSIONED' })]]) {
    assert.equal(notamArea(record, createNotamAreaReferences(navigation(features))), undefined);
  }
  // A co-named VOT does not supply VOR radials or make the VOR ambiguous.
  assert.deepEqual(notamArea(record, createNotamAreaReferences(navigation([station(), station({ type: 'VOT' })])))?.polygons, area.polygons);
});

test('named centers need exact published identities; airport associations disambiguate a co-named VOR', () => {
  const airport: GeoPointFeature = { type: 'Feature', id: 'airport:TST', geometry: { type: 'Point', coordinates: [-77.1, 39.1] },
    properties: { kind: 'landing-facility', faaId: 'TST', icaoId: 'KTST' } };
  const references = createNotamAreaReferences(navigation([station()], [airport]));
  const record = notice({ text: 'AIRSPACE PJE WI AN AREA DEFINED AS 2NM RADIUS OF TST SFC-6500FT' });
  assert.deepEqual(notamArea(record, references)?.labelPosition, airport.geometry.coordinates);
  assert.equal(notamArea({ ...record, icaoLocations: [] }, references), undefined);
  assert.deepEqual(notamArea({ ...record, text: record.text.replace('OF TST', 'OF KTST') }, references)?.labelPosition, airport.geometry.coordinates);
  assert.deepEqual(notamArea({ ...record, text: record.text.replace('OF TST', 'OF TST VOR/DME') }, references)?.labelPosition, station().geometry.coordinates);
  assert.equal(notamArea({ ...record, text: record.text.replace('OF TST', 'OF XXX') }, references), undefined);
  assert.ok(notamAreaDefinition(record)?.locations.length);
});

test('balloon area heights remain qualified MSL and do not remove lighting status from the reader', () => {
  const record = notice({ text: 'OBST MOORED BALLOON WI AN AREA DEFINED AS .25NM RADIUS OF 392110N0742613W (9.3NM SE ACY) 1000FT (1000FT AGL) FLAGGED AND LGTD' });
  assert.equal(notamArea(record)?.label, 'Balloon activity\n1000FT MSL (1000FT AGL)');
  const reading = chartedNotamPresentation(record)!.presentation.searchText.toUpperCase();
  for (const word of ['1000FT', 'AGL', 'FLAGGED', 'LGTD']) assert.ok(reading.includes(word));
  assert.deepEqual(auditMappedNotam(record), []);
});

test('GPS outer footprint is qualified and all altitude tiers survive the shorter reader', () => {
  const record = notice({ text: gps }), area = notamArea(record)!;
  assert.equal(area.label, 'GPS may be unavailable\nOuter extent\nFL400-UNL'); assert.equal(area.outer, true);
  for (const vertex of area.polygons[0]![0]!) assert.ok(Math.abs(distanceNm(area.labelPosition, vertex) - 468) < 1e-7);
  const shortened = chartedNotamPresentation(record)!;
  assert.match(shortened.note, /Outer area.*varies with altitude/);
  const text = shortened.presentation.blocks.map(notamBlockText).join(' ');
  for (const value of ['FL400-UNL', '425NM', 'FL250', '360NM', '10000FT', '354NM', '4000FT AGL', '327NM', '50FT AGL']) assert.ok(text.includes(value), value);
  assert.match(text, /may not be available/i); assert.doesNotMatch(text, /330702N1062540W/);
});

test('service footprints retain affected airports, including ARC, and altitude after the airport list', () => {
  const text = 'ADS-B, AUTO DEPENDENT SURVEILLANCE REBROADCAST (ADS-R), TFC INFO SER BCST (TIS-B), ' +
    'FLT INFO SER BCST (FIS-B) SER MAY NOT BE AVBL WI AN AREA DEFINED AS 141NM RADIUS OF 384306N1254053W. ' +
    'AP AIRSPACE AFFECTED MAY INCLUDE STS, LLR. 2000FT-UNL.';
  for (const body of [text, text.replace('STS, LLR', 'ARC'), text.replace('OF 384306', 'OF384306')]) {
    const record = notice({ classification: 'FDC', text: body }), area = notamArea(record)!;
    assert.equal(area.label, 'ADS-B services may be unavailable\n2000FT-UNL');
    assert.ok(area.polygons[0]![0]!.every(p => Math.abs(distanceNm(area.labelPosition, p) - 141) < 1e-7));
    const reading = chartedNotamPresentation(record)!.presentation.searchText.toUpperCase();
    assert.ok(reading.includes('AP AIRSPACE AFFECTED MAY INCLUDE'));
    assert.ok(reading.includes('2000FT-UNL'));
    assert.deepEqual(auditMappedNotam(record), []);
  }
  assert.equal(notamArea(notice({ text: text + ' EXCLUDING AIRSPACE EAST OF THE CENTER' })), undefined);
});

test('nonmonotonic GPS tiers use the largest published radius and preserve every source tier', () => {
  const record = notice({ text: gps.replace('468NM', '43NM').replace('425NM', '72NM').replace('360NM', '40NM')
    .replace('354NM', '35NM').replace('327NM', '30NM') }), area = notamArea(record)!;
  assert.equal(area.preserveText, true); assert.equal(area.label, 'GPS may be unavailable\nOuter extent');
  assert.ok(area.polygons[0]![0]!.every(p => Math.abs(distanceNm(area.labelPosition, p) - 72) < 1e-7));
  assert.deepEqual(chartedNotamPresentation(record)!.presentation, presentNotam(record));
  assert.deepEqual(auditMappedNotam(record), []);
  const fractional = notice({ text: gps.replace('468NM', '.8NM').replace('425NM', '.4 NM').replace('360NM', '.3NM').replace('354NM', '.2NM').replace('327NM', '.1NM') });
  assert.equal(notamAreaDefinition(fractional)?.radius, .8, 'field separators must not consume the decimal point');
  assert.ok(notamArea(fractional));
  assert.equal(notamArea(notice({ text: gps.replace('425NM', 'M425NM') })), undefined, 'no partial numeric recovery of a radius token');
});

test('mixed coordinate precision, station aliases, zero-distance radials and ORGIN closure consume complete vertices', () => {
  for (const center of ['3700N1220030W (GTB)', '370015N12200W (1AZ0)', '370015N1220030W (E60 )']) {
    const record = notice({ text: `AIRSPACE UAS WI AN AREA DEFINED AS .5NM RADIUS OF ${center} SFC-400FT AGL` });
    assert.ok(notamArea(record)); assert.deepEqual(auditMappedNotam(record), []);
  }
  const references = createNotamAreaReferences(navigation([station()]));
  const record = notice({ text: 'AIRSPACE UAS WI AN AREA DEFINED AS TST000000 TO TST100010 TO TST190010 TO POINT OF ORGIN SFC-400FT AGL' });
  assert.deepEqual(notamArea(record, references)?.labelPosition, station().geometry.coordinates);
  assert.equal(notamArea(notice({ text: circle.replace('4.0NM WSW DFW', 'EXC') })), undefined);
});

test('two-point corridors follow the published lateral distance and stop at their endpoints', () => {
  const record = notice({ text: 'AIRSPACE UAS WI AN AREA DEFINED AS 2NM EITHER SIDE OF A LINE FM 000000N0010000W TO 000000N0010000E SFC-400FT AGL' });
  const area = notamArea(record)!;
  assert.ok(area.polygons[0]![0]!.length >= 5);
  for (const [lon, lat] of area.polygons[0]![0]!) {
    assert.ok(lon >= -1 - 1e-8 && lon <= 1 + 1e-8);
    assert.ok(Math.abs(distanceNm([lon, 0], [lon, lat]) - 2) < .0001);
  }
  assert.equal(notamAreaDefinition(record)?.halfWidthNm, 2);
  assert.deepEqual(auditMappedNotam(record), []);
  assert.equal(notamArea(notice({ text: record.text.replace('0010000E', '0010000W') })), undefined);
});

test('duplicate filings share geometry and labels but retain every identity; different limits remain distinct', () => {
  const first = notice({ text: circle }), second = notice({ id: '1757600000000002', classification: 'FDC', text: circle });
  const features = notamChartFeatures([first, second], NOTAM_NOW).features;
  assert.equal(features.length, 2);
  for (const feature of features) assert.deepEqual(feature.properties.noticeIds, [first.id, second.id]);
  assert.equal(notamChartFeatures([second], NOTAM_NOW).features[0]!.properties.noticeId, second.id);
  const different = { ...second, text: circle.replace('SFC-400FT', 'SFC-800FT') };
  assert.equal(notamChartFeatures([first, different], NOTAM_NOW).features.length, 4);
});

test('ambiguous, malformed, partial, quoted and unsupported boundaries remain full text', () => {
  for (const text of [circle.replace('NM RADIUS OF', 'SM RADIUS OF'), circle.replace('3.2NM', '0NM'), circle.replace('3.2NM', '1000NM'),
    circle.replace('325151.50N', '326051.50N'), circle.replace('0970622W', '1810622W'), circle.replace('325151.50N0970622W', 'DFW'),
    circle.replace('4.0NM WSW DFW', 'EXC RWY 18'), circle.replace('4.0NM WSW DFW', 'ONLY'), circle + ' EXCLUDING AIRSPACE EAST OF RWY 18',
    circle + ' AND .5NM RADIUS CENTERED AT 330000.10N0970000W SFC-300FT AGL',
    circle + ' TO 330000.10N0970000W',
    'DISREGARD NOTE: ' + circle, circle.replace('UAS WI', 'UAS NOTE: WI'),
    polygon.replace(' TO POINT OF ORIGIN', ''), polygon.replace('ORIGIN', 'NOWHERE'),
    'AIRSPACE UAS WI AN AREA DEFINED AS 370000N1220000W TO 380000N1230000W TO 370000N1230000W TO 380000N1220000W TO POINT OF ORIGIN SFC-400FT AGL',
    gps + ' EXCLUDING AIRSPACE OVER THE AIRPORT', circle + 'X'.repeat(65536),
  ]) {
    const record = notice({ text });
    assert.equal(notamArea(record), undefined, text.slice(0, 160));
    assert.equal(chartedNotamPresentation(record), undefined, text.slice(0, 160));
  }
});

test('geometry receipt controls shortened text; raw, search, altitude and schedule stay complete', () => {
  const text = circle + ' DLY 1100-0300', record = notice({ text, schedule: 'DLY 1100-0300', translations: [] });
  const render = (charted?: ReadonlySet<string>) => renderToStaticMarkup(createElement(NotamList, { entries: [{ record }], now: NOTAM_NOW, charted }));
  const original = render(), mapped = render(new Set([notamChartKey(record)]));
  assert.ok(original.includes('325151.50N0970622W')); assert.ok(!original.includes('shown on chart'));
  assert.doesNotMatch(mapped.slice(0, mapped.indexOf('<details')).replace(/<[^>]*>/g, ''), /325151.50N0970622W/);
  assert.match(mapped, /Area shown on chart/); assert.match(mapped, /SFC-400FT AGL/); assert.match(mapped, /DLY 1100-0300/);
  assert.ok(mapped.includes(`<pre>${text}</pre>`));
  assert.ok(presentNotam(record).searchText.includes('325151.50N0970622W'));
  assert.equal(render(new Set([record.id + ':old-revision'])), original);
  assert.equal(notamChartFeatures([{ ...record, lifecycle: 'cancelled' }], NOTAM_NOW).features.length, 0);
  assert.equal(notamChartFeatures([{ ...record, endsAt: NOTAM_NOW - 1 }], NOTAM_NOW).features.length, 0);
  const upcoming = notamChartFeatures([{ ...record, startsAt: NOTAM_NOW + 1000 }], NOTAM_NOW);
  assert.equal(upcoming.features.length, 2); assert.match(upcoming.features[0]!.properties.label, /Upcoming/);
});

test('multiple areas publish all components together and retain their individual limits', () => {
  const record = notice({ text: circle + ' AND WI AN AREA DEFINED AS 1NM RADIUS OF 330000N0970000W SFC-300FT AGL' });
  const area = notamArea(record)!;
  assert.equal(area.polygons.length, 2);
  assert.equal(notamChartFeatures([record], NOTAM_NOW).features[0]!.geometry.type, 'MultiPolygon');
  assert.equal(chartedNotamPresentation(record)!.presentation.searchText, presentNotam(record).searchText);
  assert.equal(notamArea({ ...record, text: record.text.replace('330000N', '336100N') }), undefined, 'never acknowledge a partial multi-area notice');
  assert.equal(notamArea({ ...record, text: 'DISREGARD ' + record.text }), undefined);
});

test('bent and crossing corridors union their boundaries without an artificial centerline seam', () => {
  const base = 'AIRSPACE UAS WI AN AREA DEFINED AS 2NM EITHER SIDE OF A LINE FM ';
  const text = base + '000000N0010000W TO 000000N0010000E TO 010000N0010000E TO 010000N0010000W TO 000000N0010000W SFC-400FT AGL';
  const area = notamArea(notice({ text }))!;
  assert.equal(area.polygons.length, 1);
  assert.equal(area.polygons[0]!.length, 2, 'closed route has an unfilled interior, not a filled outer hull');
  for (const ring of area.polygons[0]!) assert.deepEqual(ring[0], ring.at(-1));
  const crossed = notamArea(notice({ text: base + '000000N0010000W TO 010000N0010000E TO 000000N0010000E TO 010000N0010000W SFC-400FT AGL' }));
  assert.ok(crossed);
  const dateline = notamArea(notice({ text: base + '100000N1793000E TO 100000N1793000W TO 110000N1793000W SFC-400FT AGL' }))!;
  const longitudes = dateline.polygons.flat(2).map(p => p[0]);
  assert.ok(Math.max(...longitudes) - Math.min(...longitudes) < 2);
});

test('arc transitions obey the published direction and radius and reject inconsistent endpoints', () => {
  const center = { ...station(), geometry: { type: 'Point' as const, coordinates: [0, 0] as [number, number] } };
  const refs = createNotamAreaReferences(navigation([center]));
  const text = 'AIRSPACE MIL OPS WI AN AREA DEFINED AS 000000N0000000E TO 010000N0000000E THENCE CLOCKWISE ALONG THE TST 60NM ARC TO 000000N0010000E TO POINT OF ORIGIN SFC-FL200';
  const area = notamArea(notice({ text }), refs)!;
  const curve = area.polygons[0]![0]!.filter(p => p[0] > .01 && p[1] > .01);
  assert.ok(curve.length > 10);
  for (const point of curve) assert.ok(Math.abs(distanceNm([0, 0], point) - 60) < .01);
  assert.equal(notamArea(notice({ text: text.replace('60NM ARC', '20NM ARC') }), refs), undefined);
  assert.equal(notamArea(notice({ text }), createNotamAreaReferences(navigation([]))), undefined);
  assert.equal(notamArea(notice({ text: text.replace('DEFINED AS ', 'DEFINED AS 2NM EITHER SIDE OF A LINE FM ') }), refs), undefined,
    'a curved centerline must not silently become a straight-leg corridor');
});


test('multipart transport markers must form a complete source before multiple areas are acknowledged', () => {
  const text = 'PART 1 OF 2 ' + circle + '. END PART 1 OF 2 PART 2 OF 2 ' + circle.replace('325151.50N', '335151.50N') + '. END PART 2 OF 2';
  assert.equal(notamArea(notice({ text }))?.polygons.length, 2);
  assert.equal(notamArea(notice({ text: text.replaceAll('PART 2 OF 2', 'PART 3 OF 3') })), undefined);
  assert.equal(notamArea(notice({ text: 'PART 1 OF 2 ' + circle + ' END PART 1 OF 2' })), undefined);
  for (const suffix of ['END PART 1 OF 2 PART 2 OF 2', 'END PART 2 OF 2 END PART 1 OF 2',
    'END PART 1 OF 10', 'END PART 1 OF 2 END PART 1 OF 2 END PART 2 OF 2']) {
    assert.equal(notamArea(notice({ text: circle + ' ' + suffix })), undefined, suffix);
  }
  assert.equal(notamArea(notice({ text: circle + ' END PART 1 OF 2 ' + circle.replace('325151.50N', '335151.50N') + ' END PART 2 OF 2' }))?.polygons.length, 2);
});

test('later area introductions cannot reset an instruction or condition scope', () => {
  for (const control of ['DELETE NOTE:', 'CHANGE NOTE TO READ:', 'WHEN AUTHORIZED:', 'EXCEPT:', 'EXCLUDING', 'CANCELS']) {
    const record = notice({ text: circle + '. ' + control + ' ' + circle.replace('325151.50N', '335151.50N') });
    assert.equal(notamArea(record), undefined, control);
    assert.equal(chartedNotamPresentation(record), undefined, control);
    assert.equal(notamArea(notice({ text: circle.replace('UAS WI', `UAS ${control} WI`) })), undefined, 'scope applies before the first introduction too');
  }
});

test('unknown boundary qualifications cannot publish a whole shape, even after known operational fields', () => {
  for (const base of [circle, polygon, gps]) for (const qualification of [
    'ONLY THAT PORTION EAST OF HIGHWAY 101', 'LIMITED TO THE PORTION NORTH OF THE RIVER',
    'BOUNDED ON THE WEST BY HIGHWAY 101', 'EXCLUDING AIRSPACE EAST OF THE CENTER',
    'DLY 1100-1300 ONLY THAT PORTION EAST OF HIGHWAY 101',
    'ONLY THAT PORTION EAST OF HIGHWAY 101 OAKLAND/ZOA/ARTCC TEL 510-745-3331 IS THE FAA CDN FAC',
  ]) {
    const record = notice({ text: base + ' ' + qualification });
    assert.equal(notamArea(record), undefined, qualification);
    assert.equal(chartedNotamPresentation(record), undefined, qualification);
  }
  for (const suffix of [' DLY 1100-1300', ' FREQ 122.75', ' TEL 775-782-1401']) {
    assert.ok(notamArea(notice({ text: circle + suffix })), suffix);
  }
});
