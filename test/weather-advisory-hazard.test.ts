import assert from 'node:assert/strict';
import test from 'node:test';
import { isAwcAdvisorySnapshot } from '@zlayer/contracts';
import { normalizeAdvisories } from '../src/layers/weather-awc/source';
import captured from './fixtures/sigmet-classification-2026-10-10.json' with { type: 'json' };

const capture = captured.captures[0]!;
const missing = capture.collection.features.find(f => f.properties.seriesId === '6C')!;
const nonconvective = captured.captures[1]!.collection.features.find(f => f.properties.hazard === 'TURB')!;
const now = Date.parse(capture.capturedAt);
const normalize = (feature: unknown) => normalizeAdvisories('sigmet', [{ type: 'FeatureCollection', features: [feature] }], now, capture.source);

test('captured SIGMET cycles preserve every record, including missing hazard and clipped effective validity', () => {
  for (const record of captured.captures) {
    const before = structuredClone(record.collection);
    const result = normalizeAdvisories('sigmet', [record.collection], now, record.source);
    assert.ok(isAwcAdvisorySnapshot(result)); assert.equal(result.schemaVersion, 1);
    assert.equal(result.issues, undefined); assert.equal(result.advisories.length, record.collection.features.length);
    for (const [i, advisory] of result.advisories.entries()) {
      const source = before.features[i]!;
      assert.deepEqual(advisory.sourceProperties, source.properties);
      assert.equal(advisory.text, source.properties.rawAirSigmet.trim());
      assert.equal(advisory.validFrom, Date.parse(source.properties.validTimeFrom));
      assert.equal(advisory.validTo, Date.parse(source.properties.validTimeTo));
    }
    assert.deepEqual(record.collection, before);
  }
  const recovered = normalize(missing).advisories[0]!;
  assert.equal(recovered.hazard, 'CONVECTIVE'); assert.equal(recovered.sourceProperties.hazard, null);
});

test('missing SIGMET metadata uses only a proven family; non-convective weather remains unspecified', () => {
  for (const feature of [missing, nonconvective]) for (const absent of [null, undefined]) {
    const source = structuredClone(feature);
    if (absent === undefined) delete (source.properties as Record<string, unknown>).hazard;
    else source.properties.hazard = null;
    const result = normalize(source), advisory = result.advisories[0]!;
    assert.equal(result.issues, undefined);
    assert.equal(advisory.hazard, feature === missing ? 'CONVECTIVE' : 'UNK');
    assert.deepEqual(advisory.sourceProperties, source.properties);
  }
});

test('metadata conflicts and malformed hazards cannot be repaired by matching bulletin keywords', () => {
  for (const hazard of ['', ' ', 0, true, [], {}, 'TURB', 'ICE']) {
    const feature = structuredClone(missing);
    (feature.properties as Record<string, unknown>).hazard = hazard;
    assert.equal(normalize(feature).issues?.[0]?.reason, 'invalid-hazard');
  }
  const feature = structuredClone(nonconvective); feature.properties.hazard = 'CONVECTIVE';
  assert.equal(normalize(feature).issues?.[0]?.reason, 'invalid-hazard');
});

test('proof binds issuer, series, interval, ordered headers and one active bulletin', () => {
  const corruptions: Array<(p: Record<string, any>) => void> = [
    p => { p.seriesId = '7C'; }, p => { p.icaoId = 'KXXX'; }, p => { p.airSigmetType = 'AIRMET'; },
    p => { p.validTimeTo = '2026-10-10T18:56:00Z'; }, p => { p.validTimeFrom = '2026-10-09T16:55:00Z'; },
    p => { p.rawAirSigmet = p.rawAirSigmet.replace('101655', '101755'); },
    p => { p.rawAirSigmet = p.rawAirSigmet.replace('WSUS32', 'WSUS31'); },
    p => { p.rawAirSigmet = p.rawAirSigmet.replace('MKCC WST', 'MKCE WST'); },
    p => { p.rawAirSigmet = p.rawAirSigmet.replace('1855Z', '2460Z'); },
    p => { p.rawAirSigmet = p.rawAirSigmet.replace('CONVECTIVE SIGMET 6C', 'CONVECTIVE SIGMET...NONE'); },
    p => { p.rawAirSigmet = 'REFERENCE ONLY\n' + p.rawAirSigmet; },
    p => { p.rawAirSigmet = 'OUTLOOK VALID 101655-101855\n' + p.rawAirSigmet; },
    p => { p.rawAirSigmet += '\nCONVECTIVE SIGMET 7C\nVALID UNTIL 1855Z\nTS'; },
    p => { p.rawAirSigmet = p.rawAirSigmet.replace('DSIPTG AREA', 'CANCELLED'); },
    p => { p.rawAirSigmet = p.rawAirSigmet.split('MN ND')[0]; },
    p => { p.rawAirSigmet = p.rawAirSigmet.split('MN ND')[0] + 'OUTLOOK VALID 101855-102255\nTS'; },
    p => { p.rawAirSigmet += 'X'.repeat(100_001); },
  ];
  for (const corrupt of corruptions) {
    const feature = structuredClone(missing); corrupt(feature.properties);
    const result = normalize(feature);
    assert.equal(result.advisories.length, 0, String(corrupt));
    assert.equal(result.issues?.[0]?.reason, 'invalid-hazard', String(corrupt));
  }
});

test('header representations, outlooks, shortened validity and midnight/month rollover retain category', () => {
  const variants: Array<(p: Record<string, any>) => void> = [
    p => { p.rawAirSigmet = p.rawAirSigmet.replaceAll('\n', '\r\n').replaceAll(' ', '\t '); },
    p => { p.rawAirSigmet = p.rawAirSigmet.replace('\nMKCC', '\nSIGC\nMKCC'); },
    p => { p.rawAirSigmet = p.rawAirSigmet.replace('MKCC WST 101655', 'SIGC'); },
    p => { p.rawAirSigmet = p.rawAirSigmet.replace('SIGMET 6C', 'SIGMET 06C'); },
    p => { p.rawAirSigmet += '\nOUTLOOK VALID 101855-102255\nREF INTL SIGMET CHARLIE SERIES.'; },
    p => { p.validTimeTo = '2026-10-10T17:55:00Z'; },
    p => { p.validTimeFrom = '2026-12-31T23:55:00Z'; p.validTimeTo = '2027-01-01T01:55:00Z';
      p.rawAirSigmet = p.rawAirSigmet.replaceAll('101655', '312355').replace('1855Z', '0155Z'); },
  ];
  for (const change of variants) {
    const feature = structuredClone(missing); change(feature.properties);
    const result = normalize(feature);
    assert.equal(result.issues, undefined, String(change)); assert.equal(result.advisories[0]!.hazard, 'CONVECTIVE');
  }
});

test('recovering classification cannot excuse invalid geometry or times or alter adjacent records', () => {
  for (const field of ['geometry', 'validity']) {
    const feature = structuredClone(missing);
    if (field === 'geometry') feature.geometry.coordinates[0]![0]![1] = 99;
    else feature.properties.validTimeTo = feature.properties.validTimeFrom;
    const result = normalizeAdvisories('sigmet', [{ type: 'FeatureCollection', features: [feature, nonconvective] }], now, capture.source);
    assert.equal(result.advisories.length, 1); assert.equal(result.advisories[0]!.identifier, nonconvective.properties.seriesId);
    assert.equal(result.issues?.[0]?.reason, field === 'geometry' ? 'invalid-geometry' : 'invalid-validity');
  }
});
