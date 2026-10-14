import assert from 'node:assert/strict';
import test from 'node:test';
import { isAwcAdvisorySnapshot, type AwcAdvisoryProduct, type AwcAdvisorySnapshot } from '@zlayer/contracts';
import { normalizeAdvisories, FORECAST_HOURS, type SourceCollection } from '../src/layers/weather-awc/source';
import { advisorySource, WEATHER_NOW } from './fixtures/awc-advisories';
import captured from './fixtures/sigmet-classification-2026-10-10.json' with { type: 'json' };

const convective = captured.captures[0]!.collection.features.find(f => f.properties.seriesId === '6C')!;
const nonconvective = captured.captures[1]!.collection.features.find(f => f.properties.hazard === 'TURB')!;
const samples: { name: string; product: AwcAdvisoryProduct; inputs: SourceCollection[]; hazard: string }[] = [
  { name: 'CWA', product: 'cwa', inputs: [advisorySource('cwa')], hazard: 'TS' },
  { name: 'G-AIRMET', product: 'gairmet', inputs: FORECAST_HOURS.map(hour => advisorySource('gairmet', hour)), hazard: 'ICE' },
  { name: 'convective SIGMET', product: 'sigmet', inputs: [{ type: 'FeatureCollection', features: [convective] }], hazard: 'CONVECTIVE' },
  { name: 'non-convective SIGMET', product: 'sigmet', inputs: [{ type: 'FeatureCollection', features: [nonconvective] }], hazard: 'TURB' },
];
const first = (inputs: SourceCollection[]) => inputs[0]!.features[0] as { properties: Record<string, any>; geometry: unknown };
const normalize = (sample: typeof samples[number], inputs = structuredClone(sample.inputs)) =>
  normalizeAdvisories(sample.product, inputs,
    sample.product === 'sigmet' ? Date.parse(captured.captures[0]!.capturedAt) : WEATHER_NOW, 'test:advisory-policy');
const count = (inputs: SourceCollection[]) => inputs.reduce((n, collection) => n + collection.features.length, 0);

for (const sample of samples) test(`${sample.name}: classification policy handles missing, novel and malformed metadata`, () => {
  for (const value of [undefined, null, sample.hazard, 'NEW_SOURCE_CODE', '', ' ', 0, false, [], {}]) {
    const inputs = structuredClone(sample.inputs), p = first(inputs).properties;
    if (value === undefined) delete p.hazard; else p.hazard = value;
    const absent = value == null, novel = value === 'NEW_SOURCE_CODE';
    const usable = absent ? sample.product !== 'gairmet' : value === sample.hazard || novel && sample.hazard !== 'CONVECTIVE';
    const snapshot = normalize(sample, inputs);
    assert.ok(isAwcAdvisorySnapshot(snapshot));
    assert.equal(snapshot.advisories.length, count(inputs) - Number(!usable), `${sample.name}: ${JSON.stringify(value)}`);
    assert.equal(snapshot.issues?.length ?? 0, Number(!usable));
    if (usable) {
      const a = snapshot.advisories[0]!;
      assert.equal(a.hazard, absent ? sample.hazard === 'CONVECTIVE' ? 'CONVECTIVE' : 'UNK' : value);
      assert.equal(a.classification?.basis, absent ? sample.hazard === 'CONVECTIVE' ? 'bulletin' : 'unspecified' : 'metadata');
      assert.deepEqual(a.sourceProperties, p);
    } else {
      assert.equal(snapshot.issues![0]!.detail, absent ? 'missing-hazard' : novel ? 'category-conflict' : 'malformed-hazard');
      assert.deepEqual(JSON.parse(snapshot.issues![0]!.sourceFeature).properties, p);
    }
  }
});

test('unsupported grammar does not invalidate usable metadata, but cannot supply missing evidence or mask conflicts', () => {
  const sample = samples[2]!;
  for (const raw of ['UNSUPPORTED INTERNATIONAL BULLETIN', convective.properties.rawAirSigmet.replace('MKCC WST 101655', 'NEW HEADER EXTENSION')]) {
    for (const hazard of ['CONVECTIVE', null]) {
      const inputs = structuredClone(sample.inputs);
      Object.assign(first(inputs).properties, { rawAirSigmet: raw, hazard });
      const snapshot = normalize(sample, inputs);
      if (hazard) assert.deepEqual(snapshot.advisories[0]!.classification, { basis: 'metadata', bulletin: 'unsupported' });
      else assert.equal(snapshot.issues![0]!.detail, 'unsupported-bulletin');
    }
  }
  for (const edit of [
    (p: Record<string, any>) => { p.hazard = 'TURB'; },
    (p: Record<string, any>) => { p.icaoId = 'KXXX'; },
    (p: Record<string, any>) => { p.rawAirSigmet += '\nCANCELLED'; },
    (p: Record<string, any>) => { p.rawAirSigmet += '\nCONVECTIVE SIGMET 7C\nVALID UNTIL 1855Z\nTS'; },
    (p: Record<string, any>) => { p.rawAirSigmet = p.rawAirSigmet.replace('CONVECTIVE SIGMET 6C', 'CONVECTIVE SIGMET...NONE'); },
  ]) {
    const inputs = structuredClone(sample.inputs), p = first(inputs).properties;
    p.hazard = 'CONVECTIVE'; p.rawAirSigmet = p.rawAirSigmet.replace('MKCC WST 101655', 'NEW HEADER EXTENSION'); edit(p);
    assert.equal(normalize(sample, inputs).issues?.length, 1, String(edit));
  }
});

const meaning = (snapshot: AwcAdvisorySnapshot) => snapshot.advisories.map(a => ({ identifier: a.identifier, hazard: a.hazard,
  validFrom: a.validFrom, validTo: a.validTo, forecastHour: a.forecastHour, geometry: a.geometry }))
  .sort((a, b) => a.identifier.localeCompare(b.identifier));

for (const sample of samples) test(`${sample.name}: combinations of harmless representation changes preserve coverage and applicability`, () => {
  const expected = meaning(normalize(sample));
  // Exhaust the combinations, not just each variation in isolation. These are
  // semantic invariants independent of parser implementation and specific IDs.
  for (let mask = 0; mask < 64; mask++) {
    const inputs = structuredClone(sample.inputs);
    for (const collection of inputs) {
      if (mask & 16) collection.features.reverse();
      for (const feature of collection.features as Array<{ properties: Record<string, any> }>) {
        const p = feature.properties;
        if (mask & 1) for (const key of ['issueTime', 'creationTime', 'severity', 'altitudeLow1', 'altitudeHi1', 'top']) delete p[key];
        if (mask & 2) for (const key of ['hazard', 'icaoId', 'seriesId', 'airSigmetType']) if (typeof p[key] === 'string') p[key] = ` ${p[key]} `;
        if (mask & 4) for (const key of ['rawAirSigmet', 'cwaText']) if (typeof p[key] === 'string') p[key] = `\n${p[key].replaceAll('\n', '\r\n').replaceAll(' ', '\t ')}\n`;
        if (mask & 8) for (const key of ['validTime', 'validTimeFrom', 'validTimeTo']) if (typeof p[key] === 'string') {
          p[key] = new Date(Date.parse(p[key]) - 7 * 3600_000).toISOString().replace('Z', '-07:00');
        }
        if (mask & 32) { p.newUpstreamField = { unknown: ['extension'] }; feature.properties = Object.fromEntries(Object.entries(p).reverse()); }
      }
    }
    const before = structuredClone(inputs), snapshot = normalize(sample, inputs);
    assert.equal(snapshot.issues, undefined, `variant ${mask}`);
    assert.deepEqual(meaning(snapshot), expected, `variant ${mask}`);
    assert.deepEqual(inputs, before, 'normalization must not mutate source evidence');
  }
});

for (const sample of samples) test(`${sample.name}: independent bad records remain accounted for without losing good neighbors`, () => {
  for (const bad of [null, { type: 'Feature', properties: null }, { ...structuredClone(sample.inputs[0]!.features[0] as object), geometry: null }]) {
    const inputs = structuredClone(sample.inputs); inputs[0]!.features.unshift(bad);
    const result = normalize(sample, inputs);
    assert.deepEqual(meaning(result), meaning(normalize(sample)));
    assert.equal(result.schemaVersion, 2); assert.equal(result.issues?.length, 1);
    assert.deepEqual(JSON.parse(result.issues![0]!.sourceFeature), bad);
    assert.ok(isAwcAdvisorySnapshot(result));
  }
  const inputs = structuredClone(sample.inputs);
  inputs[0] = { ...inputs[0]!, exceededTransferLimit: true } as SourceCollection;
  assert.throws(() => normalize(sample, inputs), /incomplete or unsupported/);
});

test('calendar overflow is never silently repaired; coherent G-AIRMET frame clocks remain a package invariant', () => {
  for (const sample of samples) {
    const inputs = structuredClone(sample.inputs), p = first(inputs).properties;
    p[sample.product === 'gairmet' ? 'validTime' : 'validTimeFrom'] = '2026-02-30T16:55:00Z';
    if (sample.product === 'gairmet') assert.throws(() => normalize(sample, inputs), /invalid forecast times/);
    else assert.equal(normalize(sample, inputs).issues?.[0]?.reason, 'invalid-validity');
  }
  const sample = samples[1]!, inputs = structuredClone(sample.inputs);
  first(inputs).properties.validTime = new Date(WEATHER_NOW + 3600_000).toISOString();
  assert.throws(() => normalize(sample, inputs), /package changed/);
});

test('classification provenance and issue detail validate strictly while legacy publications remain readable', () => {
  const sample = samples[2]!, original = normalize(sample), legacy = structuredClone(original);
  delete legacy.advisories[0]!.classification;
  assert.ok(isAwcAdvisorySnapshot(legacy));
  for (const classification of [null, { basis: ['bulletin'] }, { basis: 'guess' },
    { basis: 'bulletin', bulletin: 'unsupported' }, { basis: 'unspecified', bulletin: 'matched' }]) {
    const value = structuredClone(original); Object.assign(value.advisories[0]!, { classification });
    assert.ok(!isAwcAdvisorySnapshot(value));
  }
  const inputs = structuredClone(sample.inputs); first(inputs).properties.hazard = 0;
  const partial = normalize(sample, inputs);
  assert.ok(isAwcAdvisorySnapshot(partial));
  for (const detail of [['malformed-hazard'], 'new-reason', 0]) {
    const value = structuredClone(partial); Object.assign(value.issues![0]!, { detail });
    assert.ok(!isAwcAdvisorySnapshot(value));
  }
});
