import assert from 'node:assert/strict';
import test from 'node:test';
import type { FeatureCollectionResponse, GeoPointFeature } from '@zlayer/contracts';
import { captureRadialPositions, createRouteResolver, distanceNm, featureIdent, nearbyNamedRoutePoints, nearbyVorStations,
  parseRadialDefinition, positionOnRadial, radialFormsForPoint, radialReference, routeDraftFromText,
  restoreRouteCoordinate, routeIdentificationKey, routePointLabel, routeTokensFromText, type RoutePointForm } from '@zlayer/domain';
import { identifyRoutePointWithStation, identifyRoutePoint, pointReplacementProblem, replaceIdentifiedPoint, selectRadialStation } from '../src/layers/routes/identification';
import { parseRouteEntries } from '../src/layers/routes/draft-storage';
import { routeExportText, routePointExport, foreFlightRouteUrl } from '../src/layers/routes/export';
import { appendRouteFeature, replaceRouteFeature, replaceRouteText } from '../src/layers/routes/draft';
import { removeRoutePoint } from '../src/layers/routes/removal';
import { createRouteRemovalResolver } from './helpers/route-removal';
import { directToFeature, directToRoutePoint } from '../src/layers/routes/direct-to';
import { updateRouteEntry } from '../src/layers/routes/entry';
import { identificationStations, identificationFixes } from './fixtures/route-identification';
import { compositionAirways, compositionFixes, compositionTerminal, compositionPreferred } from './fixtures/route-composition';

const airport: GeoPointFeature = { type: 'Feature', id: 'airport:KSFO', properties: { kind: 'airport', icaoId: 'KSFO', faaId: 'SFO' },
  geometry: { type: 'Point', coordinates: [-122.375, 37.619] } };
const airports: FeatureCollectionResponse = { ...identificationStations, meta: { ...identificationStations.meta, layer: 'airports', returned: 1 }, features: [airport] };
const data = { navaids: identificationStations, fixes: identificationFixes, airports };
const resolve = createRouteResolver(Object.values(data));

test('radial syntax stays one token during entry, accepts both export styles and leaves invalid input unresolved', () => {
  assert.deepEqual(routeTokensFromText('ksfo PYE/285/54 osi090010 DCT 374529N/1223030W'),
    ['KSFO', 'PYE/285/54', 'OSI/090/10', '374529N1223030W']);
  for (const input of ['PYE/285/54', 'PYE/285.25/54.5']) {
    for (let length = 0; length <= input.length; length++) assert.deepEqual(updateRouteEntry(input.slice(0, length)), { value: input.slice(0, length) });
    assert.equal(updateRouteEntry(`${input} `).commit, `${input} `);
  }
  assert.deepEqual(parseRadialDefinition('PYE000010'), { station: 'PYE', radial: 0, distanceNm: 10 });
  for (const text of ['PYE/361/10', 'PYE/090/0', 'PYE/090/', 'PYE/090/20000']) {
    assert.equal(parseRadialDefinition(text), undefined);
    assert.equal(resolve(text).waypoints.length, 0);
  }
  assert.deepEqual(routeTokensFromText('KSFO/KSJC 123/456'), ['KSFO', 'KSJC', '123', '456']);
});

test('forward/inverse radial calculations agree at cardinal bearings, alignments, dateline and high latitudes', () => {
  for (const coordinate of [[0, 0], [179.9, 70], [-122, 37]] as [number, number][]) {
    for (const declination of [-15, 0, 13]) for (const radial of [0, 90, 180, 270]) {
      const station = { ...identificationStations.features[0]!, geometry: { type: 'Point' as const, coordinates: coordinate },
        properties: { ...identificationStations.features[0]!.properties, stationDeclinationDeg: declination } };
      const position = positionOnRadial(radialReference(station)!, radial, 10);
      assert.ok(Math.abs(distanceNm(coordinate, position.coordinate) - 10) < 1e-8);
      const inverse = radialFormsForPoint(position.coordinate, [station])[0]!.form;
      assert.ok(Math.min(Math.abs(inverse.radial - radial), 360 - Math.abs(inverse.radial - radial)) < 1e-8);
      assert.ok(Math.abs(inverse.distanceNm - 10) < 1e-8);
      if (coordinate[0] === 0 && coordinate[1] === 0 && radial === 0 && declination === 0) {
        assert.equal(position.coordinate[0], 0);
        assert.ok(Math.abs(position.coordinate[1] - 10 / 3440.065 * 180 / Math.PI) < 1e-12);
      }
    }
  }
});

test('ambiguous or unaligned station identifiers never silently choose a radial origin', () => {
  const first = identificationStations.features[0]!;
  const { stationDeclinationDeg: _alignment, ...properties } = first.properties;
  const duplicate = { ...first, id: 'another:PYE', properties,
    geometry: { type: 'Point' as const, coordinates: [-110, 40] as [number, number] } };
  const ambiguous = createRouteResolver([{ ...identificationStations, features: [first, duplicate] }]);
  const draft = routeDraftFromText('PYE/090/10');
  assert.equal(ambiguous(draft).waypoints.length, 0);
  assert.match(ambiguous(draft).issues[0]!.message, /ambiguous/);
  const selected = selectRadialStation(draft, draft.entries[0]!, positionOnRadial(radialReference(first)!, 90, 10));
  assert.equal(ambiguous(selected).waypoints.length, 1);
  assert.equal(selectRadialStation(routeDraftFromText('KSFO'), draft.entries[0]!, selected.entries[0]!.radialPosition!).entries[0]!.text, 'KSFO');
  assert.equal(createRouteResolver([{ ...identificationStations, features: [duplicate] }])(draft).waypoints.length, 0);
});

test('typed radial positions freeze with source identity and survive absent or changed reference data', () => {
  const draft = routeDraftFromText('PYE/090/10');
  const plan = resolve(draft), saved = captureRadialPositions(draft, plan);
  assert.deepEqual(parseRouteEntries(saved.entries), saved);
  const offline = createRouteResolver([])(saved);
  assert.deepEqual(offline.waypoints[0]!.feature.geometry.coordinates, plan.waypoints[0]!.feature.geometry.coordinates);
  assert.equal(offline.waypoints[0]!.radialReferenceCurrent, false);
  assert.match(routePointExport(offline.waypoints[0]!, 'foreflight').note!, /preserve position/);
  const shifted = { ...identificationStations, features: identificationStations.features.map(feature => ({ ...feature,
    properties: { ...feature.properties, stationDeclinationDeg: 20 } })) };
  assert.deepEqual(createRouteResolver([shifted])(saved).waypoints[0]!.feature.geometry.coordinates, plan.waypoints[0]!.feature.geometry.coordinates);
  assert.equal(replaceRouteText(saved, saved.entries[0]!.id, 'OSI/090/10').entries[0]!.radialPosition, undefined);
});

test('selecting the displayed ID station preserves its source and restores the original radial definition', () => {
  const initial = routeDraftFromText('PYE/090/10');
  let draft = captureRadialPositions(initial, resolve(initial));
  let plan = resolve(draft);
  const stations = nearbyVorStations(plan.waypoints[0]!.feature.geometry.coordinates, identificationStations.features);
  const pye = stations.find(station => featureIdent(station.feature) === 'PYE')!;
  const osi = stations.find(station => featureIdent(station.feature) === 'OSI')!;
  draft = identifyRoutePointWithStation(draft, plan, plan.waypoints[0]!, osi);
  plan = resolve(draft);
  assert.equal(plan.waypoints[0]!.identification?.kind, 'radial');
  assert.deepEqual(draft.entries[0]!.identifications![0]!.form,
    { kind: 'radial', reference: radialReference(osi.feature), radial: osi.radial, distanceNm: osi.distanceNm });
  draft = identifyRoutePointWithStation(draft, plan, plan.waypoints[0]!, pye);
  plan = resolve(draft);
  assert.equal(draft.entries[0]!.identifications, undefined);
  assert.equal(routeExportText(plan, 'foreflight'), 'PYE/090/10');
  for (const unusable of [{ ...pye, radial: null }, { ...pye, distanceNm: 0 }]) {
    assert.equal(identifyRoutePointWithStation(draft, plan, plan.waypoints[0]!, unusable), draft);
  }
});

test('name, coordinate and alternate-station descriptions preserve pins, position, entry identity and route distance', () => {
  let draft = routeDraftFromText('KSFO BAYPT', { 0: airport.id! });
  const initial = resolve(draft), original = draft.entries[0]!;
  const alternatives = radialFormsForPoint(airport.geometry.coordinates, identificationStations.features);
  assert.ok(alternatives.length >= 2);
  for (const form of [{ kind: 'coordinate' }, alternatives[0]!.form, alternatives[1]!.form, undefined] as (RoutePointForm | undefined)[]) {
    const plan = resolve(draft);
    draft = identifyRoutePoint(draft, plan, plan.waypoints[0]!, form);
    const updated = resolve(draft);
    assert.equal(draft.entries[0]!.id, original.id);
    assert.equal(draft.entries[0]!.pinnedFeatureId, airport.id);
    assert.equal(draft.entries[0]!.text, 'KSFO');
    assert.deepEqual(updated.waypoints[0]!.feature, initial.waypoints[0]!.feature);
    assert.equal(updated.distanceNm, initial.distanceNm);
    assert.deepEqual(parseRouteEntries(draft.entries), draft);
    assert.equal(updated.waypoints[0]!.identification?.kind, form?.kind);
  }
  assert.equal(routePointLabel(resolve(draft).waypoints[0]!), 'KSFO');
});

test('nearby airport, navaid and fix options require an explicit replacement and affect only the chosen occurrence', () => {
  const draft = routeDraftFromText('KSFO KSFO');
  const plan = resolve(draft), point = plan.waypoints[1]!;
  const candidates = nearbyNamedRoutePoints(point.feature.geometry.coordinates, data);
  assert.deepEqual(new Set(candidates.map(value => value.layer)), new Set(['airports', 'navaids', 'fixes']));
  const selected = candidates.find(value => featureIdent(value.feature) === 'SFO')!;
  assert.ok(selected.offsetNm > 0);
  const replaced = replaceIdentifiedPoint(draft, plan, point, selected.feature);
  assert.equal(replaced.entries[0], draft.entries[0]);
  assert.equal(replaced.entries[1]!.id, draft.entries[1]!.id);
  assert.equal(replaced.entries[1]!.pinnedFeatureId, selected.feature.id);
  assert.deepEqual(resolve(replaced).waypoints[1]!.feature.geometry.coordinates, selected.feature.geometry.coordinates);
  assert.equal(replaceIdentifiedPoint(replaced, plan, point, airport), replaced, 'stale actions do not mutate a changed draft');
});

test('export destinations serialize exact whole-unit radials and fall back to coordinates for precision', () => {
  const plan = resolve('PYE/090/10');
  assert.equal(routeExportText(plan, 'foreflight'), 'PYE/090/10');
  assert.equal(routeExportText(plan, 'skyvector'), 'PYE090010');
  assert.equal(new URL(foreFlightRouteUrl(plan)).searchParams.get('q'), 'PYE/090/10');
  for (const format of ['foreflight', 'skyvector'] as const) {
    assert.deepEqual(resolve(routeExportText(plan, format)).waypoints[0]!.feature.geometry.coordinates, plan.waypoints[0]!.feature.geometry.coordinates);
  }
  for (const text of ['PYE/090/10.5', 'PYE/090.5/10', 'PYE/090/1000']) {
    const point = resolve(text).waypoints[0]!;
    for (const format of ['foreflight', 'skyvector', 'icao'] as const) {
      assert.match(routePointExport(point, format).note!, /rounding offset/);
      assert.ok(resolve(routeExportText(resolve(text), format)).waypoints.length === 1);
    }
  }
});

test('corrupt snapshots and point forms are rejected instead of silently changing position', () => {
  const draft = routeDraftFromText('PYE/090/10'), saved = captureRadialPositions(draft, resolve(draft));
  const bad = structuredClone(saved.entries);
  bad[0]!.radialPosition!.coordinate[0] += 1;
  assert.equal(parseRouteEntries(bad), undefined);
  const original = routeDraftFromText('KSFO'), plan = resolve(original);
  const form = radialFormsForPoint(airport.geometry.coordinates, identificationStations.features)[0]!.form;
  const changed = identifyRoutePoint(original, plan, plan.waypoints[0]!, form);
  const invalid = structuredClone(changed.entries);
  (invalid[0]!.identifications![0]!.form as typeof form).radial += 10;
  assert.equal(parseRouteEntries(invalid), undefined);
});

test('saved magnetic and true references reject missing or contradictory alignment provenance', () => {
  const magnetic = () => ({ declination: 11, model: 'WMM-2025', epoch: 2025, time: Date.UTC(2026, 8, 28) });
  const resolve = createRouteResolver(Object.values(data), undefined, undefined, undefined, magnetic);
  const draft = routeDraftFromText('KSFO/090M/10 KSFO/090T/10');
  const saved = captureRadialPositions(draft, resolve(draft));
  const missing = structuredClone(saved.entries);
  delete missing[0]!.radialPosition!.reference.magnetic;
  assert.equal(parseRouteEntries(missing), undefined);
  const mixed = structuredClone(saved.entries);
  mixed[1]!.radialPosition!.reference.magnetic = saved.entries[0]!.radialPosition!.reference.magnetic!;
  assert.equal(parseRouteEntries(mixed), undefined);
  const wrongConvention = saved.entries.map((entry, index) => index ? entry : { ...entry, text: 'KSFO/090T/10' });
  assert.equal(parseRouteEntries(wrongConvention), undefined);
});

test('presentation applies to airway, TEC and SID children without flattening constraints or gaps', () => {
  const publishedAirports = { ...airports, features: [airport, { ...airport, id: 'airport:KSJC',
    properties: { kind: 'airport', faaId: 'SJC', icaoId: 'KSJC' },
    geometry: { type: 'Point' as const, coordinates: [-121.929, 37.362] as [number, number] } }] };
  const fixes = { ...compositionFixes, features: compositionFixes.features.map(feature => ({ ...feature,
    properties: { ...feature.properties, type: 'FIX' } })) };
  const published = createRouteResolver([publishedAirports, fixes, identificationStations], compositionAirways, compositionTerminal, compositionPreferred);
  for (const text of ['SUNOL V23 EXIT', 'KSFO BAYT1 KSJC', 'KSFO BAY1 SUNOL KSJC']) {
    const draft = routeDraftFromText(text), plan = published(draft);
    const point = plan.waypoints.find(value => !value.edit)!;
    assert.ok(point, text);
    const changed = identifyRoutePoint(draft, plan, point, { kind: 'coordinate' });
    const updated = published(changed);
    assert.deepEqual(updated.issues, plan.issues);
    assert.equal(updated.distanceNm, plan.distanceNm);
    assert.deepEqual(updated.waypoints.map(value => value.feature), plan.waypoints.map(value => value.feature));
    assert.equal(updated.waypoints.find(value => routeIdentificationKey(value) === routeIdentificationKey(point))!.identification?.kind, 'coordinate');
    assert.equal(routeExportText(updated), routeExportText(plan));
    assert.ok(pointReplacementProblem(plan, point));
    assert.equal(replaceIdentifiedPoint(draft, plan, point, airport), draft);
    assert.deepEqual(parseRouteEntries(changed.entries), changed);
  }
});

test('previously saved compact radial tokens normalize without discarding surrounding entries', () => {
  const entries = [{ id: 'a', text: 'KSFO', pinnedFeatureId: airport.id }, { id: 'b', text: 'PYE090010' }];
  assert.deepEqual(parseRouteEntries(entries)?.entries, [entries[0], { id: 'b', text: 'PYE/090/10' }]);
});

test('Add and Direct To preserve a radial snapshot instead of pinning a synthetic map identifier', () => {
  const draft = routeDraftFromText('PYE/090/10'), saved = captureRadialPositions(draft, resolve(draft));
  const plan = resolve(saved), point = plan.waypoints[0]!;
  const rendered = { ...point.feature, properties: { ...point.feature.properties,
    radialPosition: JSON.stringify(point.radialPosition) }, geometry: { type: 'Point' as const,
      coordinates: [-122, 38] as [number, number] } };
  assert.deepEqual(restoreRouteCoordinate(rendered).geometry, point.feature.geometry,
    'map-rounded and restored selections recover the exact saved position');
  for (const changed of [appendRouteFeature(routeDraftFromText(''), rendered),
    directToFeature(rendered, [-122, 37]), directToRoutePoint(saved, plan, point, [-122, 37])]) {
    assert.deepEqual(parseRouteEntries(changed.entries), changed);
    assert.equal(changed.entries.at(-1)!.pinnedFeatureId, undefined);
    const offline = createRouteResolver([])(changed);
    assert.deepEqual(offline.issues, []);
    assert.deepEqual(offline.waypoints.at(-1)!.feature.geometry.coordinates, point.feature.geometry.coordinates);
  }
});

test('repeated children have independent descriptions and survive persistence and unrelated prefix changes', () => {
  const resolve = createRouteRemovalResolver();
  let draft = routeDraftFromText('KSBA LOOP1 KSMX');
  const plan = resolve(draft), repeats = plan.waypoints.filter(point => point.ident === 'TAILS');
  assert.equal(repeats.length, 2);
  assert.notEqual(routeIdentificationKey(repeats[0]!), routeIdentificationKey(repeats[1]!));
  draft = identifyRoutePoint(draft, plan, repeats[1]!, { kind: 'coordinate' });
  const restored = parseRouteEntries(draft.entries)!;
  for (const input of [restored, { entries: [...routeDraftFromText('350000N1190000W').entries, ...restored.entries] }]) {
    const points = resolve(input).waypoints.filter(point => point.ident === 'TAILS');
    assert.equal(points[0]!.identification, undefined);
    assert.equal(points[1]!.identification?.kind, 'coordinate');
  }
});

test('Direct To and removal carry retained child descriptions into ordinary entries and export', () => {
  const resolve = createRouteResolver([compositionFixes], compositionAirways);
  let draft = routeDraftFromText('SUNOL V23 EXIT'), plan = resolve(draft);
  draft = identifyRoutePoint(draft, plan, plan.waypoints[1]!, { kind: 'coordinate' });
  plan = resolve(draft);
  for (const next of [directToRoutePoint(draft, plan, plan.waypoints[1]!, [-122, 37]),
    removeRoutePoint(draft, plan, plan.waypoints[2]!)]) {
    assert.notEqual(next, draft);
    assert.deepEqual(parseRouteEntries(next.entries), next);
    const updated = resolve(next), retained = updated.waypoints.find(point => point.ident === 'MID')!;
    assert.equal(retained.identification?.kind, 'coordinate');
    assert.deepEqual(retained.feature.geometry, plan.waypoints[1]!.feature.geometry);
    assert.ok(routeExportText(updated).includes(routePointLabel(retained)));
    assert.equal(updated.issues.length, 0);
  }
});

test('small accepted decimals remain parseable through normalization and snapshot persistence', () => {
  for (const input of ['PYE/000.00000001/10', 'PYE/090/0.00000001', 'PYE/000.000000123/0.000000456']) {
    const tokens = routeTokensFromText(input);
    assert.deepEqual(routeTokensFromText(tokens.join(' ')), tokens);
    assert.deepEqual(parseRadialDefinition(tokens[0]!), parseRadialDefinition(input));
    const draft = routeDraftFromText(input), plan = resolve(draft);
    assert.equal(plan.waypoints.length, 1);
    const saved = captureRadialPositions(draft, plan);
    assert.deepEqual(parseRouteEntries(saved.entries), saved);
  }
});

test('a same-text radial replacement retains the newly selected reference snapshot', () => {
  const draft = routeDraftFromText('PYE/090/10'), saved = captureRadialPositions(draft, resolve(draft));
  const changedStations = { ...identificationStations, features: identificationStations.features.map(feature => ({ ...feature,
    properties: { ...feature.properties, stationDeclinationDeg: 20 } })) };
  const changed = createRouteResolver([changedStations])(draft).waypoints[0]!;
  const replaced = replaceRouteFeature(saved, saved.entries[0]!.id, changed.feature);
  assert.deepEqual(replaced.entries[0]!.radialPosition, changed.radialPosition);
  assert.notDeepEqual(replaced.entries[0]!.radialPosition!.coordinate, saved.entries[0]!.radialPosition!.coordinate);
});

test('fix and airport references preserve true/magnetic semantics, model provenance and offline position', () => {
  const magnetic = () => ({ declination: 11, model: 'WMM-2025', epoch: 2025, time: Date.UTC(2026, 8, 28) });
  const resolveBearing = createRouteResolver(Object.values(data), undefined, undefined, undefined, magnetic);
  for (const text of ['BAYPT/090/10', 'BAYPT/090M/10', 'BAYPT/090T/10', 'KSFO/090M/10', 'KSFO/090T/10', 'PYE/090M/10', 'PYE/090T/10']) {
    for (let length = 0; length <= text.length; length++) assert.deepEqual(updateRouteEntry(text.slice(0, length)), { value: text.slice(0, length) });
    const draft = routeDraftFromText(text), plan = resolveBearing(draft), point = plan.waypoints[0]!;
    assert.equal(plan.issues.length, 0, text);
    const trueBearing = /\dT\//.test(text);
    assert.equal(point.radialPosition!.reference.bearing, trueBearing ? 'true' : 'magnetic');
    assert.equal(point.radialPosition!.reference.declination, trueBearing ? 0 : 11);
    assert.equal(point.radialPosition!.reference.magnetic?.model, trueBearing ? undefined : 'WMM-2025');
    const saved = captureRadialPositions(draft, plan);
    assert.deepEqual(parseRouteEntries(saved.entries), saved);
    const offline = createRouteResolver([])(saved);
    assert.deepEqual(offline.waypoints[0]!.feature.geometry, point.feature.geometry);
    assert.equal(offline.waypoints[0]!.radialReferenceCurrent, false);
    const ff = routeExportText(plan, 'foreflight');
    assert.ok(ff.includes(trueBearing ? 'T/' : 'M/'), ff);
    assert.deepEqual(resolveBearing(ff).waypoints[0]!.feature.geometry, point.feature.geometry);
    for (const format of ['skyvector', 'icao'] as const) {
      const exported = routeExportText(plan, format);
      assert.ok(!exported.includes('/'), exported);
      assert.ok(resolve(exported).waypoints.length === 1);
    }
  }
  assert.equal(resolve('BAYPT/090/10').waypoints.length, 0, 'missing magnetic model must not mean zero variation');
  assert.equal(resolve('BAYPT/090T/10').waypoints.length, 1, 'true bearings need no magnetic model');
  assert.equal(resolveBearing('BAYPT/090R/10').waypoints.length, 0, 'a named fix cannot supply a published VOR radial');
  assert.equal(resolveBearing('PYE/090/10').waypoints[0]!.radialPosition!.reference.declination, 13, 'VOR defaults retain published alignment');
  assert.equal(createRouteResolver([airports], undefined, undefined, undefined, magnetic)('SFO/090/10').waypoints.length, 0,
    'a missing navaid source must not silently substitute the airport short alias');
  assert.equal(resolveBearing('SFO/090M/10').waypoints[0]!.radialPosition!.reference.id, 'navaid:SFO',
    'explicit bearings follow primary identifiers before airport aliases');
});

test('ambiguous named bearing origins require selection; a typed reference is not limited to the nearby search radius', () => {
  const duplicate = { ...identificationFixes.features[0]!, id: 'other:BAYPT',
    geometry: { type: 'Point' as const, coordinates: [-110, 40] as [number, number] } };
  const resolve = createRouteResolver([{ ...identificationFixes, features: [...identificationFixes.features, duplicate] }]);
  const draft = routeDraftFromText('BAYPT/090T/200'), plan = resolve(draft);
  assert.equal(plan.waypoints.length, 0);
  assert.match(plan.issues[0]!.message, /ambiguous/);
  const chosen = createRouteResolver([identificationFixes])(draft).waypoints[0]!;
  const selected = selectRadialStation(draft, draft.entries[0]!, chosen.radialPosition!);
  assert.deepEqual(resolve(selected).waypoints[0]!.feature.geometry, chosen.feature.geometry);
  assert.deepEqual(parseRouteEntries(selected.entries), selected);
});
