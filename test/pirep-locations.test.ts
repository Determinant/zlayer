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
function points(ov: string) {
  const parsed = location(ov);
  assert.equal(parsed.kind, 'points', ov); return parsed.points;
}
function recovery(ov: string) {
  const parsed = location(ov);
  assert.equal(parsed.kind, 'recovery', ov); return parsed;
}
function compassDescription(ov: string) {
  const { description } = recovery(ov);
  assert.equal(description.kind, 'compass', ov); return description;
}

test('FAA /OV point, radial-distance, route and degrees/minutes forms are fully consumed', () => {
  for (const ov of ['GFK180005', 'GFK 180005', 'GFK 180 005']) {
    assert.deepEqual(points(ov), [{ kind: 'offset', ident: 'GFK', bearing: 'magnetic', radial: 180, distanceNm: 5 }]);
  }
  assert.deepEqual(points('GFK360000'), [{ kind: 'offset', ident: 'GFK', bearing: 'magnetic', radial: 0, distanceNm: 0 }]);
  for (const ident of ['KJFK', 'W55', '0B5', '1CA9']) {
    assert.deepEqual(points(ident), [{ kind: 'reference', ident }], 'bare airport identifiers are standard /OV locations');
  }
  assert.deepEqual(points('KJFK107080'), [{ kind: 'offset', ident: 'KJFK', bearing: 'magnetic', radial: 107, distanceNm: 80 }]);
  assert.deepEqual(points('KFMG233016'), [{ kind: 'offset', ident: 'KFMG', bearing: 'magnetic', radial: 233, distanceNm: 16 }]);
  assert.equal(points('KSTL090030-KMKC045015').length, 2);
  assert.equal(points('KSTL – KMKC - GFK').length, 3);
  assert.deepEqual(points('3901N 08446W'), [{ kind: 'coordinate', coordinate: [-84 - 46 / 60, 39 + 1 / 60] }]);
  assert.deepEqual(points('3901S08446E'), [{ kind: 'coordinate', coordinate: [84 + 46 / 60, -39 - 1 / 60] }]);
  assert.deepEqual(points('0000N 18000W'), [{ kind: 'coordinate', coordinate: [-180, 0] }]);
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
  assert.deepEqual(readPirepLocation('GFK UA /OV GFK180005 /RM PREVIOUS /OV KGFK'), { kind: 'parsed', location: location('GFK180005') });
});

test('compass offsets recover the reporting airport with explicit assumptions and geographic directions', () => {
  const raw = 'HYA UA /OV 2 N/TM 2108/FL2000/TP P212/SK OVC007';
  const parsed = readPirepLocation(raw);
  assert.ok('location' in parsed);
  assert.equal(parsed.location.kind, 'recovery');
  assert.deepEqual(parsed.location.anchor, { ident: 'HYA', source: 'reporting-station' });
  assert.deepEqual(parsed.location.description, { kind: 'compass', direction: 'N', radial: 0, distance: { value: 2, unit: 'NM', distanceNm: 2 } });
  const hya: GeoPointFeature = { ...airport, id: 'hya-airport', geometry: { type: 'Point', coordinates: [-70.28, 41.67] },
    properties: { kind: 'airport', ident: 'HYA', faaId: 'HYA', icaoId: 'KHYA' } };
  const vor: GeoPointFeature = { ...station(), properties: { ...station().properties, ident: 'HYA' } };
  const result = createPirepLocationReferences(navigation([vor], [hya]))(parsed.location, pirepFixture().checkedAt);
  assert.ok('coordinate' in result); assert.equal(result.estimated, true);
  assert.equal(result.description, 'Approx. 2 NM N of HYA (reporting station)');
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
    assert.deepEqual(recovery(ov).anchor, { ident: 'GFK', source: 'reporting-station' }, ov);
    assert.deepEqual(compassDescription(ov), { kind: 'compass', direction: 'N', radial: 0, distance: { value: 2, unit: 'NM', distanceNm: 2 } }, ov);
  }
  for (const ov of ['2 NNE', '2 NORTH NORTHEAST', '2 NORTH-NORTH-EAST', '2 NM NNE', '2 MILES NNE']) {
    assert.equal(compassDescription(ov).radial, 22.5, ov);
  }
  assert.equal(compassDescription('7 SOUTH').radial, 180);
  for (const ov of ['2 N OF KHYA', '2 N KHYA', 'KHYA 2 N', 'KHYA N 2', '2 MILES N OF KHYA']) {
    assert.deepEqual(recovery(ov).anchor, { ident: 'KHYA', source: 'explicit' }, ov);
    assert.deepEqual(compassDescription(ov), { kind: 'compass', direction: 'N', radial: 0, distance: { value: 2, unit: 'NM', distanceNm: 2 } }, ov);
  }
  assert.equal(compassDescription('2SM NE').distance.distanceNm, 2 * 1609.344 / 1852);
  assert.equal(compassDescription('.5 NM SW').distance.distanceNm, .5);
  for (const ident of ['10N', '2NE']) {
    const parsed = location(ident);
    assert.equal(parsed.kind, 'identifier-or-recovery'); assert.equal(parsed.ident, ident);
  }
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

test('compass descriptions without a reporting station cannot become distance-only airport references', () => {
  for (const header of ['UA', 'UNKN UA', '123 UA']) {
    for (const direction of ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
      'NORTH EAST', 'NORTH-NORTH-WEST', 'SOUTH', 'WEST']) {
      for (const unit of ['NM', 'SM', 'MILES']) {
        for (const ov of [`2 ${unit} ${direction}`, `${direction} 2 ${unit}`]) {
          assert.equal(readPirepLocation(`${header} /OV ${ov}/TM 1516`).kind, 'rejected', `${header} /OV ${ov}`);
        }
      }
    }
  }
  const explicit = readPirepLocation('UA /OV 2 NM OF NNE/TM 1516');
  assert.ok('location' in explicit, 'OF makes the airport reference explicit even when its identifier resembles a direction');
  const nne: GeoPointFeature = { ...airport, id: 'nne-airport', properties: { kind: 'airport', ident: 'NNE' } };
  const result = createPirepLocationReferences(navigation([], [nne]))(explicit.location, pirepFixture().checkedAt);
  assert.ok('coordinate' in result);
  assert.deepEqual(result.coordinate, nne.geometry.coordinates);
  assert.equal(result.description, 'Approx. 2 NM from NNE; airport reference, direction unknown');
});

test('recognized invalid syntax stays rejected while unsupported syntax stays unrecognized', () => {
  for (const ov of ['1000 N', '1000 MILES', '20 NM', 'GFK361005', 'GFK1801000', '3960N08446W', 'ILS RWY 37', 'FINAL 00']) {
    assert.equal(readPirepLocation(`GFK UA /OV ${ov}/TM 1516`).kind, 'rejected', ov);
  }
  for (const ov of ['NEAR THE AIRPORT', '2 NORTH OR SOUTH', 'GFK180005 EXTRA', 'RWY 8L']) {
    assert.equal(readPirepLocation(`GFK UA /OV ${ov}/TM 1516`).kind, 'unrecognized', ov);
  }
  for (const ov of ['2 MILES', 'RNAV 15', '260020']) {
    const rejected = readPirepLocation(`UA /OV ${ov}`);
    assert.equal(rejected.kind, 'rejected');
    assert.match(rejected.reason, /Reporting airport unavailable/);
  }
});

test('coordinates own their syntax and never require a reporting airport or navigation data', () => {
  const resolve = createPirepLocationReferences();
  for (const header of ['GFK UA', 'UA', 'UNKN UA']) {
    for (const [ov, coordinate] of [['3901N 08446W', [-84 - 46 / 60, 39 + 1 / 60]], ['0200S03000E', [30, -2]]] as const) {
      const parsed = readPirepLocation(`${header} /OV ${ov}`);
      assert.equal(parsed.kind, 'parsed');
      assert.deepEqual(resolve(parsed.location, pirepFixture().checkedAt), { coordinate, description: `Decoded /OV · ${ov}` });
    }
  }
});

test('rejected compact fallbacks cannot hide a published identifier', () => {
  const time = pirepFixture().checkedAt;
  for (const header of ['GFK UA', 'UA', 'UNKN UA', '123 UA']) {
    for (const ident of ['2SM', '20SM', '2NE', '30NW']) {
      const parsed = readPirepLocation(`${header} /OV ${ident}`);
      assert.equal(parsed.kind, 'parsed');
      const published: GeoPointFeature = { ...airport, id: ident, properties: { kind: 'airport', ident } };
      assert.deepEqual(createPirepLocationReferences(navigation([], [published]))(parsed.location, time),
        { coordinate: airport.geometry.coordinates, description: `Decoded /OV · ${ident}` }, `${header} /OV ${ident}`);
      if (header !== 'GFK UA' || ident === '20SM') {
        assert.ok('reason' in createPirepLocationReferences(navigation())(parsed.location, time), 'absent identities preserve the fallback rejection');
      }
    }
  }
});

test('distance-only locations use an approximate airport reference with the direction left unknown', () => {
  const time = pirepFixture().checkedAt, resolve = createPirepLocationReferences(navigation());
  for (const ov of ['2SM', '2 SM', '2NM', '2 NM', '2 MILES', '.5 SM', '0 NM', '5 NM', '5 MILES', '5.75 SM']) {
    const result = resolve(location(ov), time);
    assert.ok('coordinate' in result, ov);
    assert.deepEqual(result.coordinate, airport.geometry.coordinates, 'no direction can be inferred from a distance alone');
    assert.equal(result.estimated, true);
    assert.match(result.description, /from GFK \(reporting station\); airport reference, direction unknown/);
  }
  const compact = resolve(location('2SM'), time);
  assert.ok('coordinate' in compact);
  assert.equal(compact.description, 'Approx. 2 SM from GFK (reporting station); airport reference, direction unknown');
  for (const ov of ['2 SM OF KGFK', 'KGFK 2 SM', '2 SM KGFK']) {
    const result = resolve(location(ov), time);
    assert.ok('coordinate' in result, ov);
    assert.deepEqual(result.coordinate, airport.geometry.coordinates);
    assert.equal(result.description, 'Approx. 2 SM from KGFK; airport reference, direction unknown');
  }
  assert.ok('coordinate' in createPirepLocationReferences({ airports: navigation().airports! })(location('2 SM'), time),
    'an unambiguous distance needs only an airport reference and no magnetic model');
  const miles = resolve(location('2 MILES OF KGFK'), time);
  assert.ok('coordinate' in miles);
  assert.equal(miles.description, 'Approx. 2 NM from KGFK; airport reference, direction unknown');
  for (const ov of ['2', '-2 SM', '1000 NM', '2 SM EXTRA TEXT', '2 SM OF UNKN', '2 SM-3 SM']) {
    assert.ok('reason' in readPirepLocation(`GFK UA /OV ${ov}/TM 1516`), ov);
  }
  for (const raw of ['UA /OV 2 SM/TM 1516', 'GFK UA /RM /OV 2 SM', 'GFK UA /OV 2 SM/OV 3 SM']) {
    assert.ok('reason' in readPirepLocation(raw), raw);
  }
  for (const airports of [[], [airport, { ...airport, id: 'duplicate' }]]) {
    assert.ok('reason' in createPirepLocationReferences(navigation([station()], airports))(location('2SM'), time),
      'missing or ambiguous reporting airports cannot use a same-ID VOR');
  }
  assert.ok('reason' in resolve(location('2 SM OF KHYA'), time), 'an unavailable explicit airport cannot fall back to the header');
});

test('distance-only airport markers stay within 5 NM without limiting located offsets or identifiers', () => {
  const time = pirepFixture().checkedAt, resolve = createPirepLocationReferences(navigation());
  for (const distance of ['5.001 NM', '5.76 SM', '6 MILES', '20 NM', '999 NM']) {
    for (const ov of [distance, `${distance} OF KGFK`, `KGFK ${distance}`]) {
      assert.ok('reason' in readPirepLocation(`GFK UA /OV ${ov}/TM 1516`), ov);
    }
  }
  for (const ov of ['6SM', '20NM']) {
    assert.ok('reason' in resolve(location(ov), time), 'unknown compact identifiers cannot bypass the distance limit');
  }
  for (const ov of ['6 MILES N', '20 NM N']) {
    const result = resolve(location(ov), time);
    assert.ok('coordinate' in result, 'a supplied direction still permits a real offset');
    assert.ok(distanceNm(result.coordinate, airport.geometry.coordinates) > 5);
  }
});

test('compact distance and compass recovery require complete lookup and preserve known identifiers', () => {
  const time = pirepFixture().checkedAt;
  for (const ident of ['2SM', '2NM', '20SM', '2NE', '30NW']) {
    const parsed = location(ident);
    const published: GeoPointFeature = { ...airport, id: ident, geometry: { type: 'Point', coordinates: [-74, 41] },
      properties: { kind: 'airport', ident, faaId: ident } };
    assert.deepEqual(createPirepLocationReferences(navigation([], [airport, published]))(parsed, time),
      { coordinate: published.geometry.coordinates, description: `Decoded /OV · ${ident}` });
    assert.ok('reason' in createPirepLocationReferences(navigation([], [airport, published, { ...published, id: 'duplicate' }]))(parsed, time));
    const unsupported: GeoPointFeature = { ...station(), properties: { kind: 'navaid', ident, type: 'NDB' } };
    assert.ok('reason' in createPirepLocationReferences(navigation([unsupported]))(parsed, time), 'unsupported known identities remain unresolved');
    for (const layer of ['airports', 'navaids'] as const) {
      const data = navigation(), collection = data[layer]!;
      assert.ok('reason' in createPirepLocationReferences({ ...data, [layer]: undefined })(parsed, time));
      assert.ok('reason' in createPirepLocationReferences({ ...data,
        [layer]: { ...collection, meta: { ...collection.meta, truncated: true } } })(parsed, time));
    }
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
    const parsed = recovery(ov);
    assert.deepEqual(parsed.anchor, { ident: 'GFK', source: 'reporting-station' }, ov);
    assert.equal(parsed.description.kind, 'approach');
    const resolved = createPirepLocationReferences({ airports: navigation().airports! })(parsed, pirepFixture().checkedAt);
    assert.ok('coordinate' in resolved); assert.deepEqual(resolved.coordinate, airport.geometry.coordinates);
    assert.match(resolved.description, /airport reference, position along approach unknown/);
  }
  for (const ov of ['KGFK RNAV 15', 'RNAV 15 KGFK', 'RNAV 15 AT KGFK']) {
    assert.deepEqual(recovery(ov).anchor, { ident: 'KGFK', source: 'explicit' }, ov);
  }
  assert.deepEqual(points('GPS1'), [{ kind: 'reference', ident: 'GPS1' }], 'bare airport IDs retain precedence');
  for (const ov of ['RNAV 00', 'RNAV 37', 'RNAV 15 EXTRA', 'RNAV 15-33', 'RNAV 15 AT UNKN']) {
    assert.ok('reason' in readPirepLocation(`BTV UUA /OV ${ov}/TM 2121`), ov);
  }
  assert.ok('reason' in readPirepLocation('UA /OV RNAV 15/TM 2121'), 'implicit approaches need a reporting airport');
  assert.ok('reason' in readPirepLocation('BTV UUA /RM RNAV 15'), 'remarks cannot supply an approach location');
  assert.ok('reason' in createPirepLocationReferences(navigation())(location('RNAV 15 AT KBTV'), pirepFixture().checkedAt),
    'missing explicit approach airports do not fall back to the header');
});

test('runway departures retain airport context without inventing a position along the departure', () => {
  const time = pirepFixture().checkedAt, resolve = createPirepLocationReferences({ airports: navigation().airports! });
  for (const ov of ['DEP 4', 'DEP 04', 'DEP RWY4', 'DEP RUNWAY 04', 'ON DEP RWY 4', 'DEPARTURE 4', 'DEPARTURE RWY04']) {
    const parsed = recovery(ov);
    assert.deepEqual(parsed.anchor, { ident: 'GFK', source: 'reporting-station' }, ov);
    assert.deepEqual(parsed.description, { kind: 'departure', runway: '04' }, ov);
    assert.deepEqual(resolve(parsed, time), { coordinate: airport.geometry.coordinates, estimated: true,
      description: 'Approx. DEP RWY 04 at GFK (reporting station); airport reference, position along departure unknown' });
  }
  for (const ov of ['KGFK DEP 4L', 'DEP RWY 04L KGFK', 'DEP 04L AT KGFK']) {
    const parsed = recovery(ov);
    assert.deepEqual(parsed.anchor, { ident: 'KGFK', source: 'explicit' }, ov);
    assert.deepEqual(parsed.description, { kind: 'departure', runway: '04L' }, ov);
    assert.deepEqual(resolve(parsed, time), { coordinate: airport.geometry.coordinates, estimated: true,
      description: 'Approx. DEP RWY 04L at KGFK; airport reference, position along departure unknown' });
  }
  for (const ov of ['DEP 1', 'DEP 36R', 'DEP 09C']) assert.ok('coordinate' in resolve(location(ov), time), ov);
  for (const ov of ['DEP 00', 'DEP 37', 'DEP RWY 99']) {
    assert.equal(readPirepLocation(`GFK UA /OV ${ov}`).kind, 'rejected', ov);
  }
  for (const ov of ['DEP 4 EXTRA', 'DEP 4-22', 'DEP -4', 'DEP 004', 'DEP 4LR', 'DEP 4 OF UNKN', 'DEP 4 AT FORCK', 'DEPARTURE']) {
    assert.ok('reason' in readPirepLocation(`GFK UA /OV ${ov}`), ov);
  }
  for (const header of ['UA', 'UNKN UA', '123 UA']) {
    assert.equal(readPirepLocation(`${header} /OV DEP 4`).kind, 'rejected', 'implicit departures require a reporting airport');
  }
  for (const raw of ['GFK UA /RM /OV DEP 4', 'GFK UA /OV DEP 4/OV GFK']) assert.ok('reason' in readPirepLocation(raw), raw);
  assert.ok('reason' in resolve(location('DEP 4 AT KAMA'), time), 'an unavailable explicit airport cannot fall back to the header');
  for (const airports of [[], [airport, { ...airport, id: 'duplicate' }]]) {
    assert.ok('reason' in createPirepLocationReferences(navigation([station()], airports))(location('DEP 4'), time),
      'a missing or ambiguous airport cannot use a same-ID VOR');
  }
  for (const ident of ['DEP', 'DEP4']) assert.deepEqual(points(ident), [{ kind: 'reference', ident }], 'published identifiers retain precedence');
  assert.deepEqual(points('DEP040010'), [{ kind: 'offset', ident: 'DEP', bearing: 'magnetic', radial: 40, distanceNm: 10 }]);
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
