import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { isPirepSnapshot, type GeoPointFeature, type NavigationData, type PirepPayload } from '@zlayer/contracts';
import { distanceNm, positionOnRadial, radialReference } from '@zlayer/domain';
import modelJson from './fixtures/magnetic-model.json';
import { isMagneticModel, magneticField } from '../src/core/geo/magnetic-model';
import { decodePirepSource } from '../src/layers/weather-awc/pireps/decode';
import { readPirepLocation } from '../src/layers/weather-awc/pireps/location';
import { createPirepLocationReferences } from '../src/layers/weather-awc/pireps/location-references';
import { createPirepLocations, type PirepLocations } from '../src/layers/weather-awc/pireps/locations';
import { selectedPireps } from '../src/layers/weather-awc/pireps/selection';
import { weatherAwcPreferences } from '../src/layers/weather-awc/preferences';

const checkedAt = Date.parse('2026-10-13T22:34:29Z');
const records = await Promise.all(['lwm', 'cybl-kbfi'].map(name =>
  readFile(new URL(`./fixtures/pireps/2026-10-13-${name}.xml`, import.meta.url), 'utf8')));
const fixRecords = await Promise.all(['forck', 'skn'].map(name =>
  readFile(new URL(`./fixtures/pireps/2026-10-14-${name}.xml`, import.meta.url), 'utf8')));
const departureRecord = await readFile(new URL('./fixtures/pireps/2026-10-14-ama-dep.xml', import.meta.url), 'utf8');
const october15 = JSON.parse(await readFile(new URL('./fixtures/pireps/2026-10-15-unplotted.json', import.meta.url), 'utf8')) as
  Extract<PirepPayload, { schemaVersion: 2 }>;
const references = JSON.parse(await readFile(new URL('./fixtures/pireps/2026-10-01-locations.json', import.meta.url), 'utf8')) as
  { airports: GeoPointFeature[]; navaids: GeoPointFeature[]; fixes: GeoPointFeature[] };
function navigation(airports = references.airports, navaids = references.navaids, fixes = references.fixes): NavigationData {
  return {
    airports: { type: 'FeatureCollection', features: airports, meta: { revision: '2026-10-01', layer: 'airports', returned: airports.length, truncated: false } },
    navaids: { type: 'FeatureCollection', features: navaids, meta: { revision: '2026-10-01', layer: 'navaids', returned: navaids.length, truncated: false } },
    fixes: { type: 'FeatureCollection', features: fixes, meta: { revision: '2026-10-01', layer: 'fixes', returned: fixes.length, truncated: false } },
  };
}
function location(text: string) {
  const parsed = readPirepLocation(`DEN UA /OV ${text}/TM 2210/FL050`);
  assert.ok('location' in parsed, text); return parsed.location;
}
const vor = (ident: string): GeoPointFeature => ({ type: 'Feature', id: `fixture:${ident}`,
  geometry: { type: 'Point', coordinates: [-97, 35] },
  properties: { kind: 'navaid', ident, type: 'VORTAC', stationDeclinationDeg: 9 } });

test('all six exclusions in the 16:58 October 15 capture become selectable from either wire format', () => {
  assert.ok(isMagneticModel(modelJson));
  const payloads: PirepPayload[] = [october15,
    { schemaVersion: 1, source: october15.source, checkedAt: october15.checkedAt, reports: [],
      issues: october15.records.map((sourceXml, i) => ({ id: `legacy-oct15-${i}`, sourceXml, reason: 'Unusable source report' })) }];
  const awg = references.airports.find(f => f.properties.faaId === 'AWG')!;
  const pou = references.airports.find(f => f.properties.faaId === 'POU')!;
  const djt = references.airports.find(f => f.properties.faaId === 'DJT')!;
  const dpa = references.navaids.find(f => f.properties.ident === 'DPA')!;
  const ekr = references.navaids.find(f => f.properties.ident === 'EKR')!;
  for (const payload of payloads) {
    const snapshot = decodePirepSource(payload), before = JSON.stringify(snapshot), derive = createPirepLocations();
    assert.ok(isPirepSnapshot(snapshot)); assert.equal(snapshot.issues.length, 5);
    assert.equal(derive(snapshot)!.reports.length, 1, 'receipt recovery is independent of navigation');
    const resolved: PirepLocations = derive(snapshot, navigation(), modelJson)!;
    assert.equal(resolved.reports.length, 6); assert.equal(resolved.issues.length, 0);
    const reportFor = (station: string) => resolved.reports.find(report => report.text.startsWith(`${station} `))!;
    const cid = reportFor('CID'), pouReport = reportFor('POU'), eeo = reportFor('EEO');
    assert.equal(cid.decodedLocation, 'Approx. 3 NM NW of KAWG');
    assert.equal(pouReport.decodedLocation, 'Approx. 1 NM W of POU; miles interpreted as NM');
    assert.equal(eeo.decodedLocation, 'Approx. decoded /OV (assumed padding) · EKR0304053 · EKR 304° / 53 NM');
    assert.equal(eeo.locationEstimated, true);
    assert.equal(cid.locationEstimated, true); assert.equal(pouReport.locationEstimated, true);
    for (const [report, origin, radial, distance] of [[cid, awg, 315, 3], [pouReport, pou, 270, 1]] as const) {
      const expected = positionOnRadial({ id: origin.id!, ident: '', coordinate: origin.geometry.coordinates,
        declination: 0, revision: '', sourceKey: '' }, radial, distance).coordinate;
      assert.deepEqual([report.longitude, report.latitude], expected);
    }
    assert.deepEqual([eeo.longitude, eeo.latitude], positionOnRadial(radialReference(ekr)!, 304, 53).coordinate);
    for (const [station, anchor, detail] of [['PBI', djt, /radial 820° \(invalid\)/], ['DPA', dpa, /distance unknown/]] as const) {
      const report = reportFor(station);
      assert.deepEqual([report.longitude, report.latitude], anchor.geometry.coordinates);
      assert.equal(report.locationReferenceOnly, true); assert.equal(report.locationEstimated, true);
      assert.match(report.decodedLocation!, /observation position unknown/); assert.match(report.decodedLocation!, detail);
    }
    const lts = reportFor('LTS');
    assert.equal(lts.timeSource, 'receipt'); assert.equal(lts.observedAt, lts.receivedAt);
    assert.equal(lts.receivedAt, Date.parse('2026-10-15T16:23:42.373Z'));
    assert.deepEqual([lts.longitude, lts.latitude], [-99.2678, 34.668]);
    assert.match(lts.text, /TM 1711/); assert.deepEqual(lts.quality, ['no_time_stamp']);
    for (const report of resolved.reports) {
      const issue = snapshot.issues.find(issue => issue.report?.id === report.id);
      if (!issue) { assert.deepEqual(report, snapshot.reports.find(original => original.id === report.id)); continue; }
      const { longitude: _lon, latitude: _lat, sourceXml, decodedLocation: _label,
        locationEstimated: _estimated, locationReferenceOnly: _reference, ...observation } = report;
      assert.deepEqual(observation, issue.report, 'weather, altitude, time, quality and raw text survive recovery');
      assert.equal(sourceXml, issue.sourceXml);
    }
    assert.deepEqual(selectedPireps({ selectedTime: null, now: october15.checkedAt, pireps: { loading: false, snapshot, resolved },
      preferences: weatherAwcPreferences.select({ awcEnabled: true, awcPireps: true }) }), resolved.reports);
    assert.deepEqual(derive(snapshot, navigation([], [], []), modelJson)!.reports, [lts], 'withdrawing references withdraws every derived point');
    assert.equal(JSON.stringify(snapshot), before);
  }
  const records = october15.records.slice(3).map(xml => xml.replace('<quality_control_flags><bad_location>TRUE</bad_location></quality_control_flags>', ''));
  const snapshot = decodePirepSource({ ...october15, records });
  assert.deepEqual(createPirepLocations()(snapshot, navigation(), modelJson)!.reports, snapshot.reports,
    'valid source coordinates retain precedence over every new recovery');
});

test('seventh distinct captured failure, STJ reversed cloud heights, preserves both heights and its source point', async () => {
  const sourceXml = (await readFile(new URL('./fixtures/pireps/2026-10-15-stj.xml', import.meta.url), 'utf8')).trim();
  const checkedAt = Date.parse('2026-10-15T17:26:37Z');
  const payloads: PirepPayload[] = [
    { schemaVersion: 2, source: 'AWC capture', checkedAt, records: [sourceXml] },
    { schemaVersion: 1, source: 'AWC capture', checkedAt, reports: [], issues: [{ id: 'legacy-stj', sourceXml, reason: 'Invalid fields' }] },
  ];
  for (const payload of payloads) {
    const snapshot = decodePirepSource(payload), resolved = createPirepLocations()(snapshot)!;
    assert.ok(isPirepSnapshot(snapshot)); assert.equal(resolved.issues.length, 0); assert.equal(resolved.reports.length, 1);
    const report = resolved.reports[0]!;
    assert.deepEqual(report.sky, ['OVC · reported base 25000 / top 2000 ft MSL (inconsistent)']);
    assert.deepEqual([report.longitude, report.latitude], [-94.9252, 39.9606]);
    assert.equal(report.sourceXml, sourceXml); assert.equal(report.observedAt, Date.parse('2026-10-15T16:50:00Z'));
    assert.deepEqual(selectedPireps({ selectedTime: null, now: checkedAt, pireps: { loading: false, snapshot, resolved },
      preferences: weatherAwcPreferences.select({ awcEnabled: true, awcPireps: true }) }), [report]);
  }
});

test('incomplete or invalid offsets expose only a unique published reference, never an invented observation position', () => {
  const gfk = vor('GFK'), lwm = vor('LWM'), forck = references.fixes[0]!;
  const data = navigation([], [gfk, lwm], [forck]), resolve = createPirepLocationReferences(data);
  for (const [phrase, anchor] of [['GFK020', gfk], ['GFK361005', gfk], ['GFK1801000', gfk],
    ['LWM 230 1000', lwm], ['LWM 361 01', lwm], ['FORCK361010', forck], ['FORCK2701000', forck]] as const) {
    const result = resolve(location(phrase), checkedAt);
    assert.ok('coordinate' in result, phrase);
    assert.deepEqual(result.coordinate, anchor.geometry.coordinates, phrase);
    assert.equal(result.referenceOnly, true); assert.equal(result.estimated, true);
    assert.match(result.description, /observation position unknown/);
    assert.match(result.description, /invalid|unknown/);
  }
  for (const navaids of [[], [gfk, { ...gfk, id: 'duplicate' }], [{ ...gfk, properties: { ...gfk.properties, type: 'NDB' } }]]) {
    assert.ok('reason' in createPirepLocationReferences(navigation([], navaids, []))(location('GFK020'), checkedAt));
  }
  const ordinary = resolve(location('GFK180005'), checkedAt);
  assert.ok('coordinate' in ordinary); assert.equal(ordinary.referenceOnly, undefined);
  assert.deepEqual(ordinary.coordinate, positionOnRadial(radialReference(gfk)!, 180, 5).coordinate);
  for (const phrase of ['GFK02', 'GFK020 EXTRA', 'GFK020/UNKNOWN', 'GFK020 /OV GFK', 'DEP 004', 'ILS 004']) {
    assert.ok('reason' in readPirepLocation(`GFK UA /OV ${phrase}`), phrase);
  }
});

test('compact compass/reference boundaries resolve against complete published identities', () => {
  const resolve = createPirepLocationReferences(navigation());
  for (const [compact, spaced] of [['3NWKAWG', '3 NW KAWG'], ['3 NWKAWG', '3 NW KAWG'],
    ['3NMNWKAWG', '3 NM NW KAWG'], ['3SMNWKAWG', '3 SM NW KAWG'], ['.5MIWKAWG', '.5 MI W KAWG']]) {
    assert.deepEqual(resolve(location(compact!), checkedAt), resolve(location(spaced!), checkedAt), compact);
    assert.ok('coordinate' in resolve(location(compact!), checkedAt));
  }
  const abc = vor('ABC'), eabc = vor('EABC');
  const compact = location('3NEABC');
  for (const [reference, phrase] of [[abc, '3 NE ABC'], [eabc, '3 N EABC']] as const) {
    const resolve = createPirepLocationReferences(navigation([], [reference]));
    assert.deepEqual(resolve(compact, checkedAt), resolve(location(phrase), checkedAt));
  }
  for (const alternate of [eabc, { ...eabc, properties: { ...eabc.properties, type: 'NDB' } }]) {
    const result = createPirepLocationReferences(navigation([], [abc, alternate]))(compact, checkedAt);
    assert.ok('reason' in result); assert.match(result.reason, /ambiguous reference encoding/);
  }
  const ambiguous = createPirepLocationReferences(navigation([], [abc, { ...abc, id: 'duplicate' }]))(compact, checkedAt);
  assert.ok('reason' in ambiguous); assert.match(ambiguous.reason, /ambiguous reference/);
  for (const layer of ['airports', 'navaids', 'fixes'] as const) {
    const data = navigation();
    const collection = data[layer]!;
    assert.ok('reason' in createPirepLocationReferences({ ...data, [layer]: undefined })(location('3NWKAWG'), checkedAt));
    const partial = { ...data, [layer]: { ...collection, meta: { ...collection.meta, truncated: true } } };
    assert.ok('reason' in createPirepLocationReferences(partial)(location('3NWKAWG'), checkedAt));
  }
  for (const phrase of ['3NWZZZ', '3NEABC']) assert.ok('reason' in resolve(location(phrase), checkedAt), 'unknown references cannot use the header');
  for (const phrase of ['1000NWKAWG', '3NWKAWG EXTRA', '3NWKAWG-GFK', '-3NWKAWG', '3NWKAWG /OV POU']) {
    assert.ok('reason' in readPirepLocation(`CID UA /OV ${phrase}/TM 1553`), phrase);
  }
  assert.ok('reason' in readPirepLocation('CID UA /RM /OV 3NWKAWG'), 'remarks cannot supply a compact location');
});

test('extra radial zero recovery preserves ordinary readings and real identifier boundaries', () => {
  const ekr = vor('EKR'), ekr0 = vor('EKR0');
  const resolve = createPirepLocationReferences(navigation([], [ekr]));
  for (const phrase of ['EKR0304053', 'EKR 0304053', 'EKR 0304 053']) {
    const result = resolve(location(phrase), checkedAt);
    assert.ok('coordinate' in result, phrase);
    assert.deepEqual(result.coordinate, positionOnRadial(radialReference(ekr)!, 304, 53).coordinate);
    assert.match(result.description, /EKR 304° \/ 53 NM/);
  }
  const ordinary = resolve(location('EKR0300053'), checkedAt);
  assert.ok('coordinate' in ordinary);
  assert.deepEqual(ordinary.coordinate, positionOnRadial(radialReference(ekr)!, 30, 53).coordinate,
    'an already valid three-digit radial is never reinterpreted as 300 degrees');
  const standard = createPirepLocationReferences(navigation([], [ekr, ekr0]))(location('EKR0304053'), checkedAt);
  assert.ok('coordinate' in standard);
  assert.deepEqual(standard.coordinate, positionOnRadial(radialReference(ekr0)!, 304, 53).coordinate);
  const unaligned = { ...ekr0, properties: { ...ekr0.properties } };
  delete unaligned.properties.stationDeclinationDeg;
  assert.ok('reason' in createPirepLocationReferences(navigation([], [ekr, unaligned]))(location('EKR0304053'), checkedAt));
  const unsupported = { ...ekr0, properties: { ...ekr0.properties, type: 'NDB' } };
  assert.ok('reason' in createPirepLocationReferences(navigation([], [ekr, unsupported]))(location('EKR0304053'), checkedAt),
    'a known unsupported standard reference cannot silently become a padded radial');
  const data = navigation([], [ekr]);
  const partial = { ...data, navaids: { ...data.navaids!, meta: { ...data.navaids!.meta, truncated: true } } };
  assert.ok('reason' in createPirepLocationReferences(partial)(location('EKR0304053'), checkedAt),
    'partial reference data cannot establish that EKR0 is absent');
  for (const phrase of ['EKR 0361 053', 'EKR 1304 053', 'EKR 0304 53', 'EKR 00304 053', 'EKR 0304 0053', 'EKR 0304053 EXTRA']) {
    assert.ok('reason' in readPirepLocation(`EEO UA /OV ${phrase}`), phrase);
  }
});

test('reported RNT distance-only text recovers from either wire format with the missing direction disclosed', () => {
  const raw = 'RNT UA /OV 2SM/TM 1835/FL023/TP M20/RM DURD';
  const checkedAt = Date.parse('2026-10-14T18:40:00Z');
  // Synthetic XML and reference around the reported raw text; not an AWC capture.
  const member = `<AircraftReport><raw_text>${raw}</raw_text><report_type>PIREP</report_type>
    <observation_time>2026-10-14T18:35:00Z</observation_time><aircraft_ref>M20</aircraft_ref>
    <altitude_ft_msl>2300</altitude_ft_msl></AircraftReport>`;
  const rnt: GeoPointFeature = { type: 'Feature', id: 'fixture:rnt', geometry: { type: 'Point', coordinates: [-122.22, 47.49] },
    properties: { kind: 'airport', ident: 'RNT', faaId: 'RNT', icaoId: 'KRNT' } };
  const data = navigation([rnt], [vor('RNT')]);
  for (const quality of ['', '<quality_control_flags><bad_location>TRUE</bad_location></quality_control_flags>']) {
    const sourceXml = member.replace('</AircraftReport>', `${quality}</AircraftReport>`);
    const payloads: PirepPayload[] = [
      { schemaVersion: 2, source: 'Synthetic RNT regression', checkedAt, records: [sourceXml] },
      { schemaVersion: 1, source: 'Synthetic RNT regression', checkedAt, reports: [],
        issues: [{ id: 'legacy-rnt', reason: 'Location unavailable', sourceXml }] },
    ];
    for (const payload of payloads) {
      const snapshot = decodePirepSource(payload), before = JSON.stringify(snapshot), derive = createPirepLocations();
      assert.ok(isPirepSnapshot(snapshot)); assert.equal(snapshot.issues.length, 1);
      assert.equal(derive(snapshot)!.reports.length, 0, 'recovery waits for reference data');
      const resolved = derive(snapshot, data)!;
      assert.equal(resolved.issues.length, 0); assert.equal(resolved.reports.length, 1);
      const report = resolved.reports[0]!;
      assert.deepEqual([report.longitude, report.latitude], rnt.geometry.coordinates);
      assert.equal(report.locationEstimated, true);
      assert.equal(report.decodedLocation, 'Approx. 2 SM from RNT (reporting station); airport reference, direction unknown');
      assert.equal(report.observedAt, Date.parse('2026-10-14T18:35:00Z'));
      assert.equal(report.altitudeFt, 2300); assert.equal(report.aircraft, 'M20');
      assert.deepEqual(report.sky, []); assert.deepEqual(report.turbulence, []); assert.deepEqual(report.icing, []);
      assert.deepEqual(report.quality, quality ? ['bad_location'] : []);
      assert.equal(report.text, raw); assert.equal(report.sourceXml, sourceXml);
      assert.deepEqual(selectedPireps({ selectedTime: null, now: checkedAt, pireps: { loading: false, snapshot, resolved },
        preferences: weatherAwcPreferences.select({ awcEnabled: true, awcPireps: true }) }), [report]);
      assert.equal(derive(snapshot, navigation([], [vor('RNT')]))!.reports.length, 0, 'withdrawing the airport removes its derived marker');
      assert.equal(JSON.stringify(snapshot), before, 'recovery preserves source evidence');
    }
  }
  const located = member.replace('</AircraftReport>', '<longitude>-122.25</longitude><latitude>47.5</latitude></AircraftReport>');
  const snapshot = decodePirepSource({ schemaVersion: 2, source: 'Synthetic RNT regression', checkedAt, records: [located] });
  const report = createPirepLocations()(snapshot, data)!.reports[0]!;
  assert.deepEqual([report.longitude, report.latitude], [-122.25, 47.5], 'valid source coordinates keep precedence');
  assert.equal(report.locationEstimated, undefined);
});

test('captured AMA runway departure recovers in both wire formats without turning DURC into a zero-foot altitude', () => {
  const checkedAt = Date.parse('2026-10-15T00:09:30Z');
  const ama = references.airports.find(feature => feature.properties.faaId === 'AMA')!;
  assert.ok(ama);
  const data = { airports: navigation().airports! };
  const payloads: PirepPayload[] = [
    { schemaVersion: 2, source: 'AWC capture', checkedAt, records: [departureRecord] },
    { schemaVersion: 1, source: 'AWC capture', checkedAt, reports: [],
      issues: [{ id: 'legacy-ama-departure', reason: 'Unreliable location', qualityFlag: 'bad_location', sourceXml: departureRecord }] },
  ];
  for (const payload of payloads) {
    const snapshot = decodePirepSource(payload), before = JSON.stringify(snapshot), derive = createPirepLocations();
    assert.ok(isPirepSnapshot(snapshot)); assert.equal(snapshot.issues.length, 1);
    assert.equal(derive(snapshot)!.reports.length, 0, 'recovery waits for the published airport');
    const resolved = derive(snapshot, data)!;
    assert.equal(resolved.issues.length, 0); assert.equal(resolved.reports.length, 1);
    const report = resolved.reports[0]!;
    assert.deepEqual([report.longitude, report.latitude], ama.geometry.coordinates);
    assert.equal(report.locationEstimated, true);
    assert.equal(report.decodedLocation, 'Approx. DEP RWY 04 at AMA (reporting station); airport reference, position along departure unknown');
    assert.equal(report.observedAt, Date.parse('2026-10-14T23:41:00Z'));
    assert.equal(report.receivedAt, Date.parse('2026-10-14T23:45:20.110Z'));
    assert.equal(report.altitudeFt, null); assert.equal(report.aircraft, 'C680');
    assert.deepEqual(report.sky, ['OVC · 4500–5300 ft MSL']);
    assert.deepEqual(report.turbulence, []); assert.deepEqual(report.icing, []);
    assert.deepEqual(report.quality, ['bad_location']);
    assert.equal(report.text, 'AMA UA /OV DEP 4/TM 2341/FLDURC/TP C680/SK OVC045-TOPS053');
    assert.equal(report.sourceXml, departureRecord);
    assert.deepEqual(selectedPireps({ selectedTime: null, now: checkedAt, pireps: { loading: false, snapshot, resolved },
      preferences: weatherAwcPreferences.select({ awcEnabled: true, awcPireps: true }) }), [report]);
    assert.equal(derive(snapshot, navigation([], [vor('AMA')]))!.reports.length, 0, 'a same-ID VOR cannot replace the withdrawn airport');
    assert.equal(JSON.stringify(snapshot), before, 'raw evidence and cloud heights remain intact');
  }
  const located = departureRecord.replace('<quality_control_flags><bad_location>TRUE</bad_location></quality_control_flags>', '');
  const snapshot = decodePirepSource({ schemaVersion: 2, source: 'Location-flag mutation of AWC capture', checkedAt, records: [located] });
  const report = createPirepLocations()(snapshot, data)!.reports[0]!;
  assert.deepEqual([report.longitude, report.latitude], [-101.7059, 35.2194], 'valid source coordinates retain precedence');
  assert.equal(report.locationEstimated, undefined); assert.equal(report.altitudeFt, null);
});

test('captured FORCK offset and corroborated SKN typo recover from both wire formats into map selection', () => {
  assert.ok(isMagneticModel(modelJson));
  const checkedAt = Date.parse('2026-10-14T02:01:30Z');
  const payloads: PirepPayload[] = [
    { schemaVersion: 2, source: 'AWC capture', checkedAt, records: fixRecords },
    { schemaVersion: 1, source: 'AWC capture', checkedAt, reports: [], issues: fixRecords.map((sourceXml, i) =>
      ({ id: `old-fix-issue-${i}`, sourceXml, reason: 'Unreliable location', qualityFlag: 'bad_location' })) },
  ];
  for (const payload of payloads) {
    const snapshot = decodePirepSource(payload), before = JSON.stringify(snapshot), derive = createPirepLocations();
    assert.ok(isPirepSnapshot(snapshot)); assert.equal(snapshot.issues.length, 2);
    assert.deepEqual(snapshot.issues[1]!.sourceCoordinate, [-97.6213, 38.9251]);
    const { fixes: _fixes, ...withoutFixes } = navigation();
    assert.equal(derive(snapshot, withoutFixes, modelJson)!.reports.length, 0);
    const withoutModel: PirepLocations = derive(snapshot, navigation())!;
    assert.equal(withoutModel.reports.length, 1);
    assert.match(withoutModel.issues[0]!.reason, /FORCK: magnetic model unavailable/);
    const resolved: PirepLocations = derive(snapshot, navigation(), modelJson)!;
    assert.equal(resolved.issues.length, 0); assert.equal(resolved.reports.length, 2);
    const forck = resolved.reports.find(r => r.text.startsWith('TRL '))!;
    const skn = resolved.reports.find(r => r.text.startsWith('SLN '))!;
    const fix = references.fixes.find(f => f.properties.ident === 'FORCK')!;
    const sln = references.navaids.find(f => f.properties.ident === 'SLN')!;
    const field = magneticField(modelJson, fix.geometry.coordinates, 0, forck.observedAt)!;
    const expected: [number, number] = positionOnRadial({ id: fix.id!, ident: 'FORCK', coordinate: fix.geometry.coordinates,
      declination: field.declination, revision: '', sourceKey: '' }, 270, 10).coordinate;
    assert.deepEqual([forck.longitude, forck.latitude], expected);
    assert.ok(Math.abs(distanceNm(expected, fix.geometry.coordinates) - 10) < 1e-7);
    assert.equal(forck.altitudeFt, 25000); assert.deepEqual(forck.turbulence, ['CAT LGT · 24000–25000 ft MSL']);
    assert.equal(forck.decodedLocation, 'Decoded /OV · FORCK270010');
    assert.deepEqual([skn.longitude, skn.latitude], sln.geometry.coordinates);
    assert.equal(skn.locationEstimated, true);
    assert.match(skn.decodedLocation!, /Approx\. \/OV SKN → SLN; reporting station and source position agree/);
    assert.match(skn.text, /\/OV SKN/); assert.deepEqual(skn.quality, ['bad_location']);
    assert.equal(forck.sourceXml, fixRecords[0]); assert.equal(skn.sourceXml, fixRecords[1]);
    assert.equal(selectedPireps({ selectedTime: null, now: checkedAt, pireps: { loading: false, snapshot, resolved },
      preferences: weatherAwcPreferences.select({ awcEnabled: true, awcPireps: true }) }).length, 2);
    const moved: GeoPointFeature = { ...fix, geometry: { type: 'Point', coordinates: [-95, 33] } };
    assert.notEqual(derive(snapshot, navigation(undefined, undefined, [moved]), modelJson)!.reports[0]!.longitude, forck.longitude);
    assert.equal(JSON.stringify(snapshot), before, 'recovery preserves the complete original observations and evidence');
  }
});

test('five-letter fixes support complete point, bearing and route fields without treating suffixes as identifiers', () => {
  for (const text of ['FORCK270010', 'FORCK 270010', 'FORCK 270 010']) {
    const parsed = location(text);
    assert.equal(parsed.kind, 'points');
    assert.deepEqual(parsed.points, [{ kind: 'offset', ident: 'FORCK', bearing: 'magnetic', radial: 270, distanceNm: 10 }]);
  }
  const fix = references.fixes[0]!, resolve = createPirepLocationReferences(navigation());
  assert.deepEqual(resolve(location('FORCK'), checkedAt), { coordinate: fix.geometry.coordinates, description: 'Decoded /OV · FORCK' });
  assert.ok('coordinate' in resolve(location('FORCK-SLN'), checkedAt));
  assert.ok('coordinate' in resolve(location('2 N OF FORCK'), checkedAt));
  assert.ok('reason' in createPirepLocationReferences(navigation(undefined, undefined, [fix, { ...fix, id: 'duplicate' }]))(location('FORCK'), checkedAt));
  for (const text of ['FORCK270010 EXTRA', 'FORCKS270010', 'F0RCK270010']) {
    assert.ok('reason' in readPirepLocation(`TRL UA /OV ${text}/TM 0054`), text);
  }
});

test('a reporting-station typo needs exact coordinate corroboration and cannot replace known or ambiguous identities', () => {
  const data = navigation(), sln = references.navaids.find(f => f.properties.ident === 'SLN')!;
  const hint = { station: 'SLN', coordinate: [-97.6213, 38.9251] as [number, number] };
  const resolve = createPirepLocationReferences(data), parsed = location('SKN');
  assert.ok('coordinate' in resolve(parsed, checkedAt, hint));
  for (const unsupported of [undefined, { ...hint, coordinate: [-96, 39] as [number, number] },
    { ...hint, station: 'SXX' }, { ...hint, station: 'KSLN' }]) {
    assert.ok('reason' in resolve(parsed, checkedAt, unsupported));
  }
  for (const text of ['XXN', 'SKN010010', 'SKN-SLN']) assert.ok('reason' in resolve(location(text), checkedAt, hint), text);
  for (const layer of ['airports', 'navaids', 'fixes'] as const) {
    const collection = data[layer]!;
    const partial = { ...data, [layer]: { ...collection, meta: { ...collection.meta, truncated: true } } };
    assert.ok('reason' in createPirepLocationReferences(partial)(parsed, checkedAt, hint), 'truncated reference data cannot establish an unknown identifier');
  }
  for (const existing of [vor('SKN'), { ...vor('SKN'), properties: { kind: 'navaid', ident: 'SKN', type: 'NDB' } }]) {
    const result = createPirepLocationReferences(navigation(undefined, [...references.navaids, existing]))(parsed, checkedAt, hint);
    if (existing.properties.type === 'NDB') assert.ok('reason' in result, 'an unsupported known reference is never corrected');
    else { assert.ok('coordinate' in result); assert.deepEqual(result.coordinate, existing.geometry.coordinates); assert.equal(result.estimated, undefined); }
  }
  for (const navaids of [[...references.navaids, { ...sln, id: 'duplicate-sln' }], [...references.navaids, vor('SKN'), { ...vor('SKN'), id: 'duplicate-skn' }]]) {
    assert.ok('reason' in createPirepLocationReferences(navigation(undefined, navaids))(parsed, checkedAt, hint));
  }
  const snapshot = decodePirepSource({ schemaVersion: 2, source: 'AWC capture', checkedAt: Date.parse('2026-10-14T02:01:30Z'), records: [fixRecords[1]!] });
  for (const sourceCoordinate of [[181, 0], [0, 91], [NaN, 0], ['-97', 39], [0], [0, 0, 0], null]) {
    assert.equal(isPirepSnapshot({ ...snapshot, issues: [{ ...snapshot.issues[0], sourceCoordinate }] }), false);
  }
  const withoutPosition = fixRecords[1]!.replace(/<latitude>.*?<\/latitude>/, '');
  const missing = decodePirepSource({ schemaVersion: 2, source: 'AWC capture', checkedAt: snapshot.checkedAt, records: [withoutPosition] });
  assert.equal(createPirepLocations()(missing, data)!.reports.length, 0, 'header similarity alone cannot recover a point');
});

test('captured LWM and CYBL-KBFI entries recover through both source formats and the map selection path', () => {
  assert.ok(isMagneticModel(modelJson));
  const payloads: PirepPayload[] = [
    { schemaVersion: 2, source: 'AWC capture', checkedAt, records },
    { schemaVersion: 1, source: 'AWC capture', checkedAt, reports: [], issues: records.map((sourceXml, i) =>
      ({ id: `old-issue-${i}`, sourceXml, reason: 'Unreliable location', qualityFlag: 'bad_location' })) },
  ];
  for (const payload of payloads) {
    const snapshot = decodePirepSource(payload), before = JSON.stringify(snapshot), derive = createPirepLocations();
    assert.equal(snapshot.issues.length, 2); assert.equal(snapshot.reports.length, 0);
    assert.equal(derive(snapshot)!.reports.length, 0, 'wait for national reference identities');
    assert.match(derive(snapshot, navigation())!.issues[0]!.reason, /magnetic model unavailable/,
      'LWM is now a DME, so the airport bearing requires WMM rather than invented VOR alignment');
    const resolved: PirepLocations = derive(snapshot, navigation(), modelJson)!;
    assert.equal(resolved.issues.length, 0); assert.equal(resolved.reports.length, 2);
    const lwm = resolved.reports.find(r => r.aircraft === 'C68A')!, bfi = resolved.reports.find(r => r.aircraft === 'S22T')!;
    const airport = references.airports.find(f => f.properties.faaId === 'LWM')!;
    const field = magneticField(modelJson, airport.geometry.coordinates, 0, lwm.observedAt)!;
    const expected: [number, number] = positionOnRadial({ id: 'airport', ident: 'KLWM', coordinate: airport.geometry.coordinates,
      declination: field.declination, revision: '', sourceKey: '' }, 230, 1).coordinate;
    assert.deepEqual([lwm.longitude, lwm.latitude], expected);
    assert.match(lwm.decodedLocation!, /LWM 230° \/ 1 NM/);
    assert.equal(lwm.altitudeFt, 200); assert.equal(lwm.sourceXml, records[0]);
    assert.deepEqual(lwm.quality, ['bad_location']);
    assert.match(bfi.decodedLocation!, /^Route midpoint · CYBL-KBFI · AWC station reference: CYBL$/);
    assert.equal(bfi.locationEstimated, true); assert.equal(bfi.sourceXml, records[1]);
    assert.deepEqual(bfi.turbulence, ['NEG · below 3000 ft MSL']);
    const campbell: [number, number] = [-125.269, 49.951]; // AWC station capture, not an invented route endpoint.
    const boeing = references.airports.find(f => f.properties.icaoId === 'KBFI')!.geometry.coordinates;
    const midpoint: [number, number] = [bfi.longitude, bfi.latitude];
    assert.ok(Math.abs(distanceNm(campbell, midpoint) - distanceNm(midpoint, boeing)) < 1e-7);
    assert.ok(Math.abs(distanceNm(campbell, midpoint) * 2 - distanceNm(campbell, boeing)) < 1e-7);
    const state = { selectedTime: null, now: checkedAt, pireps: { loading: false, snapshot, resolved },
      preferences: weatherAwcPreferences.select({ awcEnabled: true, awcPireps: true }) };
    assert.equal(selectedPireps(state).length, 2, 'both recovered reports reach the map input');
    assert.equal(JSON.stringify(snapshot), before, 'all original source fields and raw evidence remain intact');
  }
});

test('distance padding recovery uses actual references without swallowing identifier digits', () => {
  for (const [text, ident, radial, distance] of [
    ['GFK18005', 'GFK', 180, 5], ['AGS27005', 'AGS', 270, 5], ['OMA02010', 'OMA', 20, 10],
    ['MQP2260020', 'MQP', 226, 20], ['MQP 226 0020', 'MQP', 226, 20],
    ['0B502005', '0B5', 20, 5], ['1CA902001', '1CA9', 20, 1],
  ] as const) {
    const station = vor(ident);
    const result = createPirepLocationReferences(navigation([], [station]))(location(text), checkedAt);
    assert.ok('coordinate' in result, text);
    assert.deepEqual(result.coordinate, positionOnRadial(radialReference(station)!, radial, distance).coordinate, text);
  }
  const lwm = vor('LWM'), lwm2 = vor('LWM2');
  const ambiguous = createPirepLocationReferences(navigation([], [lwm, lwm2]))(location('LWM23001'), checkedAt);
  assert.ok('reason' in ambiguous); assert.match(ambiguous.reason, /ambiguous reference encoding/);
  const mqp = vor('MQP'), mqp2 = vor('MQP2');
  const standard = createPirepLocationReferences(navigation([], [mqp, mqp2]))(location('MQP2260020'), checkedAt);
  assert.ok('coordinate' in standard);
  assert.deepEqual(standard.coordinate, positionOnRadial(radialReference(mqp2)!, 260, 20).coordinate,
    'a real four-character identifier with standard distance padding retains precedence');
  const unaligned: GeoPointFeature = { ...mqp2, properties: { ...mqp2.properties } };
  delete unaligned.properties.stationDeclinationDeg;
  assert.ok('reason' in createPirepLocationReferences(navigation([], [mqp, unaligned]))(location('MQP2260020'), checkedAt),
    'a known standard identity cannot fall back to another interpretation because its alignment is missing');
  for (const text of ['LWM2300010 EXTRA', 'LWM 230 00001', 'LWM 23 01']) {
    assert.ok('reason' in readPirepLocation(`LWM UA /OV ${text}`), text);
  }
});

test('bare radial-distance recovery labels its reporting-airport assumption and still requires WMM', () => {
  assert.ok(isMagneticModel(modelJson));
  const den: GeoPointFeature = { type: 'Feature', id: 'fixture:den-airport',
    geometry: { type: 'Point', coordinates: [-104.67, 39.86] },
    properties: { kind: 'airport', faaId: 'DEN', icaoId: 'KDEN' } };
  const parsed = location('260020'), data = navigation([den], [vor('DEN')]);
  const result = createPirepLocationReferences(data, modelJson)(parsed, checkedAt);
  assert.ok('coordinate' in result); assert.equal(result.estimated, true);
  assert.match(result.description, /20 NM on 260° magnetic bearing from DEN \(reporting station\)/);
  assert.ok(Math.abs(distanceNm(result.coordinate, den.geometry.coordinates) - 20) < 1e-7);
  assert.ok('reason' in createPirepLocationReferences(data)(parsed, checkedAt));
  assert.ok('reason' in readPirepLocation('UA /OV 260020'));
});

test('international station references are exact fallbacks and never replace known or ambiguous navigation identities', () => {
  const resolve = createPirepLocationReferences(navigation());
  for (const ident of ['CYBL', 'CYYJ', 'EGLL']) {
    const result = resolve(location(ident), checkedAt);
    assert.ok('coordinate' in result, ident); assert.equal(result.estimated, true);
    assert.match(result.description, /AWC station reference/);
  }
  for (const text of ['YBL', 'KYBL', 'CYBL-ZZZZ', 'CYBL RNAV 15', 'HERT']) {
    assert.ok('reason' in resolve(location(text), checkedAt), text);
  }
  const cybl: GeoPointFeature = { type: 'Feature', id: 'fixture:cybl',
    geometry: { type: 'Point', coordinates: [-125.27, 49.95] }, properties: { kind: 'airport', icaoId: 'CYBL' } };
  const supplied = createPirepLocationReferences(navigation([cybl]))(location('CYBL'), checkedAt);
  assert.ok('coordinate' in supplied); assert.deepEqual(supplied.coordinate, cybl.geometry.coordinates);
  assert.equal(supplied.estimated, undefined); assert.doesNotMatch(supplied.description, /AWC station/);
  assert.ok('reason' in createPirepLocationReferences(navigation([cybl, { ...cybl, id: 'second-cybl' }]))(location('CYBL'), checkedAt));
  assert.ok('reason' in createPirepLocationReferences({ airports: navigation().airports! })(location('CYBL-KBFI'), checkedAt));
});
