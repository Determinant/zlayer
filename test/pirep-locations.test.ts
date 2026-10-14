import assert from 'node:assert/strict';
import test from 'node:test';
import type { GeoPointFeature, NavigationData } from '@zlayer/contracts';
import { distanceNm, positionOnRadial, radialReference } from '@zlayer/domain';
import modelJson from './fixtures/magnetic-model.json';
import { isMagneticModel, magneticField } from '../src/core/geo/magnetic-model';
import { readPirepLocation } from '../src/layers/weather-awc/pireps/location';
import { createPirepLocationReferences } from '../src/layers/weather-awc/pireps/location-references';
import { createPirepLocations } from '../src/layers/weather-awc/pireps/locations';
import { createWeatherController } from '../src/layers/weather-awc/controller';
import { weatherAwcPreferences } from '../src/layers/weather-awc/preferences';
import { selectedPireps } from '../src/layers/weather-awc/pireps/selection';
import { pirepFixture } from './fixtures/pireps';

const station = (declination = 12): GeoPointFeature => ({ type: 'Feature', id: 'gfk-vor',
  geometry: { type: 'Point', coordinates: [-97.2, 47.9] },
  properties: { kind: 'navaid', ident: 'GFK', type: 'VOR/DME', stationDeclinationDeg: declination, status: 'OPERATIONAL IFR' } });
const airport: GeoPointFeature = { type: 'Feature', id: 'gfk-airport', geometry: { type: 'Point', coordinates: [-97.18, 47.94] },
  properties: { kind: 'airport', ident: 'GFK', faaId: 'GFK', icaoId: 'KGFK' } };
const navigation = (navaids = [station()], airports = [airport]): NavigationData => ({
  navaids: { type: 'FeatureCollection', features: navaids, meta: { revision: '2026-10-01', layer: 'navaids', returned: navaids.length, truncated: false } },
  airports: { type: 'FeatureCollection', features: airports, meta: { revision: '2026-10-01', layer: 'airports', returned: airports.length, truncated: false } },
});
function location(ov: string) {
  const parsed = readPirepLocation(`GFK UA /OV ${ov}/TM 1516/FL080/TP C172`);
  assert.ok('location' in parsed, ov); return parsed.location;
}

test('FAA /OV point, radial-distance, route and degrees/minutes forms are fully consumed', () => {
  for (const ov of ['GFK180005', 'GFK 180005', 'GFK 180 005']) {
    assert.deepEqual(location(ov).points, [{ ident: 'GFK', radial: 180, distanceNm: 5 }]);
  }
  assert.deepEqual(location('GFK360000').points, [{ ident: 'GFK', radial: 0, distanceNm: 0 }]);
  for (const ident of ['KJFK', 'W55', '0B5', '1CA9']) {
    assert.deepEqual(location(ident), { text: ident, points: [{ ident }] }, 'bare airport identifiers are standard /OV locations');
  }
  assert.deepEqual(location('KJFK107080').points, [{ ident: 'KJFK', radial: 107, distanceNm: 80 }]);
  assert.deepEqual(location('KFMG233016').points, [{ ident: 'KFMG', radial: 233, distanceNm: 16 }]);
  assert.equal(location('KSTL090030-KMKC045015').points.length, 2);
  assert.equal(location('KSTL – KMKC - GFK').points.length, 3);
  assert.deepEqual(location('3901N 08446W').points, [{ coordinate: [-84 - 46 / 60, 39 + 1 / 60] }]);
  assert.deepEqual(location('3901S08446E').points, [{ coordinate: [84 + 46 / 60, -39 - 1 / 60] }]);
  assert.deepEqual(location('0000N 18000W').points, [{ coordinate: [-180, 0] }]);
  assert.ok('location' in readPirepLocation('GFK UUA\r\n/OV GFK180005 /TM1516 /RM TEST'));
});

test('a bare seaplane-base identifier resolves at the published point without a radial or inferred location', () => {
  const raw = 'GFK UA /OV W55/TM 1516/FL020/TP DHC2/SK BKN030';
  const snapshot = pirepFixture(), { longitude: _longitude, latitude: _latitude, sourceXml, ...fields } = snapshot.reports[0]!;
  const report = { ...fields, text: raw, type: 'PIREP', urgent: false, aircraft: 'DHC2', altitudeFt: 2000,
    turbulence: [], sky: ['BKN · 3000–? ft MSL'], quality: ['bad_location'] };
  snapshot.reports = [];
  snapshot.issues = [{ id: 'w55-unlocated', reason: 'Location unavailable', qualityFlag: 'bad_location', sourceXml, report }];
  const derive = createPirepLocations();
  assert.match(derive(snapshot, navigation())!.issues[0]!.reason, /W55: reference unavailable/,
    'a missing explicit reference cannot fall back to the GFK reporting station');
  for (const kind of ['airport', 'landing-facility']) {
    const seaplane: GeoPointFeature = { type: 'Feature', id: 'w55-seaplane',
      geometry: { type: 'Point', coordinates: [-122.33874, 47.62899] },
      properties: { kind, ident: 'W55', faaId: 'W55', facilityType: 'SEAPLANE BASE' } };
    const recovered = derive(snapshot, navigation([station()], [airport, seaplane]))!;
    assert.equal(recovered.issues.length, 0);
    assert.equal(recovered.reports.length, 1);
    const plotted = recovered.reports[0]!;
    assert.deepEqual([plotted.longitude, plotted.latitude], seaplane.geometry.coordinates);
    assert.equal(plotted.decodedLocation, 'Decoded /OV · W55');
    assert.equal(plotted.locationEstimated, undefined, 'direct facility references are not approximate-location recovery');
    assert.equal(plotted.text, raw);
    assert.equal(plotted.sourceXml, sourceXml);
  }
});

test('the TEI reader never extracts partial locations, duplicate fields, cloud codes or remarks', () => {
  for (const ov of ['', 'UNKN', 'NEAR THE AIRPORT', 'GFK361005', 'GFK1801000', 'GFK180005 EXTRA', 'GFK180005/UNKNOWN',
    'GFK180005/', 'GFK--KGFK', 'GFK-', '-GFK', '3960N08446W', '9001N18000E', '3901N18001W',
    'GFK180005 /OV KGFK', Array(17).fill('GFK').join('-'), 'X'.repeat(513)]) {
    assert.ok('reason' in readPirepLocation(`GFK UA /OV ${ov}/TM 1516`), ov);
  }
  for (const text of ['GFK UA /RM EXAMPLE /OV GFK180005', 'GFK UA /SK OVC015-TOP035/OVC230 /RM /OV GFK180005',
    'GFK UA /TM 1516', 'AIREP /OV GFK180005', 'X'.repeat(20_001)]) assert.ok('reason' in readPirepLocation(text));
  assert.deepEqual(readPirepLocation('GFK UA /OV GFK180005 /RM PREVIOUS /OV KGFK'), { location: location('GFK180005') });
});

test('compass offsets recover the reporting airport with explicit assumptions and geographic directions', () => {
  const raw = 'HYA UA /OV 2 N/TM 2108/FL2000/TP P212/SK OVC007';
  const parsed = readPirepLocation(raw);
  assert.ok('location' in parsed);
  assert.deepEqual(parsed.location.points, [{ ident: 'HYA', radial: 0, distanceNm: 2, bearing: 'true', airportOnly: true }]);
  assert.equal(parsed.location.estimated, 'Approx. 2 NM N of HYA (reporting station)');
  const hya: GeoPointFeature = { ...airport, id: 'hya-airport', geometry: { type: 'Point', coordinates: [-70.28, 41.67] },
    properties: { kind: 'airport', ident: 'HYA', faaId: 'HYA', icaoId: 'KHYA' } };
  const vor: GeoPointFeature = { ...station(), properties: { ...station().properties, ident: 'HYA' } };
  const result = createPirepLocationReferences(navigation([vor], [hya]))(parsed.location, pirepFixture().checkedAt);
  assert.ok('coordinate' in result); assert.equal(result.estimated, true);
  assert.ok(Math.abs(result.coordinate[0] - hya.geometry.coordinates[0]) < 1e-7);
  assert.ok(result.coordinate[1] > hya.geometry.coordinates[1]);
  assert.ok(Math.abs(distanceNm(result.coordinate, hya.geometry.coordinates) - 2) < 1e-7,
    'the reporting airport wins over a same-ID VOR, without requiring a magnetic model');
  assert.ok('coordinate' in createPirepLocationReferences({ airports: navigation([], [hya]).airports! })(parsed.location, pirepFixture().checkedAt),
    'a reporting-airport offset does not depend on the navaid collection');
  for (const airports of [[], [hya, { ...hya, id: 'ambiguous-hya' }]]) {
    assert.ok('reason' in createPirepLocationReferences(navigation([vor], airports))(parsed.location, pirepFixture().checkedAt));
  }
  const snapshot = pirepFixture(), { longitude: _longitude, latitude: _latitude, sourceXml, ...fields } = snapshot.reports[0]!;
  const report = { ...fields, text: raw, type: 'PIREP', urgent: false, aircraft: 'P212', altitudeFt: null, quality: ['bad_location', 'no_flt_lvl'] };
  snapshot.reports = [];
  snapshot.issues = [{ id: 'hya-unlocated', reason: 'Location unavailable', qualityFlag: 'bad_location', sourceXml, report }];
  const recovered = createPirepLocations()(snapshot, navigation([vor], [hya]))!;
  assert.equal(recovered.issues.length, 0);
  assert.deepEqual([recovered.reports[0]!.longitude, recovered.reports[0]!.latitude], result.coordinate);
  assert.equal(recovered.reports[0]!.text, raw);
  assert.equal(recovered.reports[0]!.altitudeFt, null, 'location recovery does not reinterpret nonstandard /FL text');
});

test('compass recovery accepts bounded equivalent phrases and honors explicit references and units', () => {
  for (const ov of ['2 N', '2N', 'N 2', 'N2', '2 NORTH', '2 NM NORTH', '2 MILES NORTH']) {
    assert.deepEqual(location(ov).points, [{ ident: 'GFK', radial: 0, distanceNm: 2, bearing: 'true', airportOnly: true }], ov);
  }
  for (const ov of ['2 NNE', '2 NORTH NORTHEAST', '2 NORTH-NORTH-EAST']) {
    assert.equal((location(ov).points[0] as { radial: number }).radial, 22.5, ov);
  }
  assert.equal((location('7 SOUTH').points[0] as { radial: number }).radial, 180);
  for (const ov of ['2 N OF KHYA', '2 N KHYA', 'KHYA 2 N', 'KHYA N 2']) {
    assert.deepEqual(location(ov).points, [{ ident: 'KHYA', radial: 0, distanceNm: 2, bearing: 'true' }], ov);
    assert.equal(location(ov).estimated, 'Approx. 2 NM N of KHYA');
  }
  assert.equal((location('2SM NE').points[0] as { distanceNm: number }).distanceNm, 2 * 1609.344 / 1852);
  assert.equal((location('.5 NM SW').points[0] as { distanceNm: number }).distanceNm, .5);
  assert.deepEqual(location('10N').points, [{ ident: '10N' }], 'standard bare airport IDs cannot become inferred offsets');
  assert.deepEqual(location('2NE').points, [{ ident: '2NE' }]);
  for (const ov of ['2', '-2 N', '1000 N', '2 N EXTRA TEXT', '2 N OF UNKN', '2 NORTH OR SOUTH', '2 N-3 E']) {
    assert.ok('reason' in readPirepLocation(`HYA UA /OV ${ov}/TM 2108`), ov);
  }
  assert.ok('reason' in readPirepLocation('UA /OV 2 N/TM 2108'), 'implicit offsets require a reporting station');
  assert.ok('reason' in createPirepLocationReferences(navigation())(location('NORTH'), pirepFixture().checkedAt),
    'a five-letter token requires a published fix and cannot become a direction alone');
  assert.ok('reason' in readPirepLocation('HYA UA /RM /OV 2 N'), 'remarks never supply the location');
  assert.ok('reason' in createPirepLocationReferences(navigation())(location('2 N OF ZZZ'), pirepFixture().checkedAt),
    'an unavailable explicit reference cannot fall back to the reporting airport');
});

test('compact compass offsets resolve after checking published airport identities', () => {
  const time = pirepFixture().checkedAt, resolve = createPirepLocationReferences(navigation());
  for (const [compact, spaced] of [['30NW', '30 NW'], ['40SW', '40 SW'], ['30N', '30 N'], ['2NE', '2 NE'], ['2NNE', '2 NNE']]) {
    assert.deepEqual(resolve(location(compact!), time), resolve(location(spaced!), time), compact);
    assert.ok('reason' in createPirepLocationReferences({ airports: navigation().airports! })(location(compact!), time),
      'a compact offset waits for both reference collections before ruling out a literal identifier');
  }
  for (const ident of ['10N', '2NE', '30NW']) {
    const published: GeoPointFeature = { ...airport, id: ident, geometry: { type: 'Point', coordinates: [-74, 41] },
      properties: { kind: 'airport', ident, faaId: ident } };
    const resolved = createPirepLocationReferences(navigation([station()], [airport, published]))(location(ident), time);
    assert.deepEqual(resolved, { coordinate: published.geometry.coordinates, description: `Decoded /OV · ${ident}` },
      'an exact published identity wins over compass shorthand');
    assert.ok('reason' in createPirepLocationReferences(navigation([], [airport, published, { ...published, id: 'duplicate' }]))(location(ident), time),
      'ambiguous published identifiers cannot become offsets');
  }
});

test('the reported DEN offsets and BTV approach move from unplotted entries into the normal report collection', () => {
  const den: GeoPointFeature = { ...airport, id: 'den-airport', geometry: { type: 'Point', coordinates: [-104.67, 39.86] },
    properties: { kind: 'airport', ident: 'DEN', faaId: 'DEN', icaoId: 'KDEN' } };
  const btv: GeoPointFeature = { ...airport, id: 'btv-airport', geometry: { type: 'Point', coordinates: [-73.15, 44.47] },
    properties: { kind: 'airport', ident: 'BTV', faaId: 'BTV', icaoId: 'KBTV' } };
  const data = navigation(['DEN', 'BTV'].map(ident => ({ ...station(), id: `${ident}-vor`, properties: { ...station().properties, ident } })), [den, btv]);
  const cases = [
    { raw: 'DEN UA /OV 30NW/TM 2214/FL150/TP B737/TB MOD', aircraft: 'B737', altitudeFt: 15000, urgent: false,
      origin: den, radial: 315, distance: 30, description: 'Approx. 30 NM NW of DEN (reporting station)' },
    { raw: 'DEN UA /OV 40SW/TM 2145/FL165/TP E75L/TA -6/TB LT CHOP/IC LT CLR/RM 165-150', aircraft: 'E75L', altitudeFt: 16500, urgent: false,
      origin: den, radial: 225, distance: 40, description: 'Approx. 40 NM SW of DEN (reporting station)' },
    { raw: 'BTV UUA /OV RNAV 15/TM 2121/FL040/TP CRJ7/TB LGT-MOD 110-040 /RM DURD\n', aircraft: 'CRJ7', altitudeFt: 4000, urgent: true,
      origin: btv, radial: 0, distance: 0,
      description: 'Approx. RNAV RWY 15 at BTV (reporting station); airport reference, position along approach unknown' },
  ];
  for (const example of cases) {
    const snapshot = pirepFixture(), { longitude: _longitude, latitude: _latitude, sourceXml, ...fields } = snapshot.reports[0]!;
    const report = { ...fields, text: example.raw, type: example.urgent ? 'Urgent PIREP' : 'PIREP', urgent: example.urgent,
      aircraft: example.aircraft, altitudeFt: example.altitudeFt, quality: ['bad_location'] };
    snapshot.reports = [];
    snapshot.issues = [{ id: 'unlocated', reason: 'Location unavailable', qualityFlag: 'bad_location', sourceXml, report }];
    const before = JSON.stringify(snapshot), resolved = createPirepLocations()(snapshot, data)!;
    assert.equal(resolved.issues.length, 0, example.raw); assert.equal(resolved.reports.length, 1);
    const plotted = resolved.reports[0]!;
    const expected = example.distance ? positionOnRadial({ id: example.origin.id!, ident: '', coordinate: example.origin.geometry.coordinates,
      declination: 0, revision: '', sourceKey: '' }, example.radial, example.distance).coordinate : example.origin.geometry.coordinates;
    assert.deepEqual([plotted.longitude, plotted.latitude], expected);
    assert.equal(plotted.decodedLocation, example.description); assert.equal(plotted.locationEstimated, true);
    assert.equal(plotted.text, example.raw); assert.equal(plotted.urgent, example.urgent);
    assert.equal(JSON.stringify(snapshot), before, 'recovery preserves source evidence');
  }
});

test('approach descriptions retain their airport context without inventing a position along the procedure', () => {
  for (const ov of ['RNAV 15', 'RNAV RWY15', 'ON RNAV 15', 'RNAV (GPS) Z RWY 15', 'ILS RWY 15', 'LOC/DME 15', 'FINAL RWY 15']) {
    const parsed = location(ov);
    assert.deepEqual(parsed.points, [{ ident: 'GFK', airportOnly: true }], ov);
    assert.match(parsed.estimated!, /airport reference, position along approach unknown/);
    const resolved = createPirepLocationReferences({ airports: navigation().airports! })(parsed, pirepFixture().checkedAt);
    assert.ok('coordinate' in resolved); assert.deepEqual(resolved.coordinate, airport.geometry.coordinates);
  }
  for (const ov of ['KGFK RNAV 15', 'RNAV 15 KGFK', 'RNAV 15 AT KGFK']) {
    assert.deepEqual(location(ov).points, [{ ident: 'KGFK', airportOnly: true }], ov);
    assert.doesNotMatch(location(ov).estimated!, /reporting station/);
  }
  assert.deepEqual(location('GPS1'), { text: 'GPS1', points: [{ ident: 'GPS1' }] }, 'bare airport IDs retain precedence');
  for (const ov of ['RNAV 00', 'RNAV 37', 'RNAV 15 EXTRA', 'RNAV 15-33', 'RNAV 15 AT UNKN']) {
    assert.ok('reason' in readPirepLocation(`BTV UUA /OV ${ov}/TM 2121`), ov);
  }
  assert.ok('reason' in readPirepLocation('UA /OV RNAV 15/TM 2121'), 'implicit approaches need a reporting airport');
  assert.ok('reason' in readPirepLocation('BTV UUA /RM RNAV 15'), 'remarks cannot supply an approach location');
  assert.ok('reason' in createPirepLocationReferences(navigation())(location('RNAV 15 AT KBTV'), pirepFixture().checkedAt),
    'missing explicit approach airports do not fall back to the header');
});

test('VOR positions use published alignment and explicit airports use magnetic bearings', () => {
  const data = navigation(), resolve = createPirepLocationReferences(data), time = pirepFixture().checkedAt;
  const result = resolve(location('GFK180005'), time);
  assert.ok('coordinate' in result);
  assert.deepEqual(result.coordinate, positionOnRadial(radialReference(station())!, 180, 5).coordinate);
  assert.ok(Math.abs(distanceNm(station().geometry.coordinates, result.coordinate) - 5) < 1e-7);
  assert.deepEqual(resolve(location('GFK'), time), { coordinate: station().geometry.coordinates, description: 'Decoded /OV · GFK' });
  assert.deepEqual(resolve(location('KGFK'), time), { coordinate: airport.geometry.coordinates, description: 'Decoded /OV · KGFK' });
  assert.ok('reason' in resolve(location('KGFK180005'), time), 'never interpret magnetic bearing as true without a model');
  assert.ok(isMagneticModel(modelJson));
  const magnetic = createPirepLocationReferences(data, modelJson)(location('KGFK180005'), time);
  assert.ok('coordinate' in magnetic);
  const field = magneticField(modelJson, airport.geometry.coordinates, 0, time)!;
  const expected = positionOnRadial({ id: 'airport', ident: 'KGFK', coordinate: airport.geometry.coordinates,
    declination: field.declination, revision: '', sourceKey: '' }, 180, 5).coordinate;
  assert.deepEqual(magnetic.coordinate, expected);
  const prefixed = createPirepLocationReferences(navigation([station()], []))(location('KGFK180005'), time);
  assert.ok('coordinate' in prefixed); assert.deepEqual(prefixed.coordinate, result.coordinate, 'FAA K-prefixed VHF station form');
  const unaligned = station(); delete unaligned.properties.stationDeclinationDeg;
  for (const data of [navigation([], []), navigation([station(), station()]), navigation([unaligned])]) {
    assert.ok('reason' in createPirepLocationReferences(data, modelJson)(location('GFK180005'), time));
  }
});

test('routes resolve every reference and use a labeled geodesic midpoint across the date line', () => {
  const resolve = createPirepLocationReferences(), time = pirepFixture().checkedAt;
  const route = resolve(location('0000N17900E-0000N17900W'), time);
  assert.ok('coordinate' in route); assert.ok(Math.abs(Math.abs(route.coordinate[0]) - 180) < 1e-7);
  assert.equal(route.coordinate[1], 0); assert.match(route.description, /^Route midpoint/);
  const multi = resolve(location('0000N00000E-0000N00200E-0000N01000E'), time);
  assert.ok('coordinate' in multi); assert.ok(Math.abs(multi.coordinate[0] - 5) < 1e-7);
  assert.ok('reason' in resolve(location('0000N00000E-0000N18000E'), time));
  assert.ok('reason' in resolve(location('0000N17900E-GFK'), time), 'unresolved legs cannot disappear');
});

test('derived locations retain source evidence, recover with references, and invalidate with navigation changes', () => {
  const snapshot = pirepFixture(), source = snapshot.reports[0]!;
  const { longitude: _longitude, latitude: _latitude, sourceXml, ...fields } = source;
  const report = { ...fields, text: 'GFK UUA /OV GFK180005 /TM 1516', quality: ['bad_location'] };
  snapshot.reports = [];
  snapshot.issues = [{ id: 'unlocated', reason: 'Source location unavailable', qualityFlag: 'bad_location', sourceXml, report }];
  const before = JSON.stringify(snapshot), derive = createPirepLocations(), data = navigation();
  assert.match(derive(snapshot)!.issues[0]!.reason, /reference data unavailable/);
  const located = derive(snapshot, data)!;
  assert.equal(located.reports.length, 1); assert.equal(located.issues.length, 0);
  assert.equal(located.reports[0]!.decodedLocation, 'Decoded /OV · GFK180005');
  assert.equal(derive(snapshot, data), located, 'unchanged identities reuse derived data');
  assert.notDeepEqual(derive(snapshot, navigation([station(-10)]))!.reports[0]!.longitude, located.reports[0]!.longitude);
  assert.equal(derive(snapshot)!.reports.length, 0, 'removing references withdraws the decoded point');
  assert.equal(JSON.stringify(snapshot), before, 'decoded positions never modify cached source snapshots');
  const retransmission = { ...snapshot, issues: [...snapshot.issues, { ...snapshot.issues[0]!, id: 'duplicate',
    report: { ...report, receivedAt: report.observedAt } }] };
  const deduplicated = derive(retransmission, data)!;
  assert.equal(deduplicated.reports.length, 1); assert.equal(deduplicated.reports[0]!.receivedAt, report.observedAt);
  const approximate = { ...snapshot, issues: [{ ...snapshot.issues[0]!, report: { ...report, text: 'GFK UA /OV 7 SOUTH' } }] };
  const recovered = derive(approximate, data)!;
  assert.equal(recovered.issues.length, 0); assert.equal(recovered.reports[0]!.locationEstimated, true);
  assert.equal(recovered.reports[0]!.text, 'GFK UA /OV 7 SOUTH');
  assert.equal(recovered.reports[0]!.decodedLocation, 'Approx. 7 NM S of GFK (reporting station)');
  const invalid = { ...snapshot, issues: [{ ...snapshot.issues[0]!, report: { ...report, text: 'GFK UA /OV NEAR THE AIRPORT' } }] };
  assert.match(derive(invalid, data)!.issues[0]!.reason, /format not recognized/);
});

test('controller reference replacement repositions recovered reports and preserves normal time filtering', () => {
  const snapshot = pirepFixture(), { longitude: _longitude, latitude: _latitude, sourceXml, ...fields } = snapshot.reports[0]!;
  const report = { ...fields, observedAt: Date.now() - 60_000, text: 'GFK UUA /OV GFK180005 /TM 1516', quality: ['bad_location'] };
  snapshot.reports = []; snapshot.checkedAt = Date.now();
  snapshot.issues = [{ id: 'unlocated', reason: 'Unreliable location', qualityFlag: 'bad_location', sourceXml, report }];
  const controller = createWeatherController({ advisories: { restore: () => ({ loading: false }), refresh: async () => { throw new Error(); } } });
  const preferences = weatherAwcPreferences.select({ awcEnabled: true, awcPireps: true });
  controller.publish({ ...controller.getSnapshot(), pireps: { snapshot, loading: false } });
  controller.configure({ ...preferences, navigation: navigation(), change() {} });
  const first = selectedPireps(controller.getSnapshot())[0]!;
  assert.ok(first.decodedLocation); assert.equal(controller.getSnapshot().pireps.resolved!.issues.length, 0);
  controller.configure({ ...preferences, navigation: navigation([station(-10)]), change() {} });
  const moved = selectedPireps(controller.getSnapshot())[0]!;
  assert.equal(first.id, moved.id); assert.notEqual(first.longitude, moved.longitude);
  assert.equal(selectedPireps({ ...controller.getSnapshot(), now: report.observedAt + 91 * 60_000 }).length, 0);
  controller.configure({ ...preferences, change() {} });
  assert.equal(selectedPireps(controller.getSnapshot()).length, 0);
  controller.detach();
});
