import assert from 'node:assert/strict';
import test from 'node:test';

import type { GeoPointFeature } from '@zlayer/contracts';

import { formatObservationTime } from '../src/layers/metar-taf/metar/format.js';
import { featureDetailRows, resolveNavigationFeature } from '../src/layers/navigation/feature-details.js';
import { withMapLabelKeys } from '../src/core/map/label';

test('map sources omit nested reference details while retaining styling and exact export identity', () => {
  const feature: GeoPointFeature = { type: 'Feature', id: 'airport:KSBA',
    geometry: { type: 'Point', coordinates: [-119.84, 34.43] },
    properties: { ident: 'KSBA', kind: 'airport', facilityType: 'A', towered: true,
      longestRunwayFt: 6052, dataRevision: '2026-09-03', dataSourceKey: 'export-1',
      runways: [{ id: '07/25' }], frequencies: [{ type: 'TOWER', frequencyMHz: 119.7 }], charts: ['ENROUTE LOW'],
      metarStationId: 'KSBA', displayFlightCategory: 'VFR' } };
  const collection = { type: 'FeatureCollection' as const, features: [feature],
    meta: { layer: 'airports' as const, revision: '2026-09-03', returned: 1, truncated: false } };
  const mapped = withMapLabelKeys(collection).features[0]!;
  for (const key of ['runways', 'frequencies', 'charts']) {
    assert.equal(key in mapped.properties, false);
    assert.ok(key in feature.properties, 'the canonical record must remain complete');
  }
  for (const key of ['ident', 'kind', 'facilityType', 'towered', 'longestRunwayFt', 'dataRevision',
    'dataSourceKey', 'metarStationId', 'displayFlightCategory']) {
    assert.equal(mapped.properties[key], feature.properties[key]);
  }
  assert.equal(resolveNavigationFeature(mapped, { airports: collection }), feature);
  const anonymous: GeoPointFeature = { type: 'Feature', geometry: feature.geometry, properties: feature.properties };
  assert.equal(withMapLabelKeys({ ...collection, features: [anonymous] }).features[0]!.properties.runways, feature.properties.runways);
});

test('formats weather details without malformed variable-wind notation', () => {
  const feature: GeoPointFeature = {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [-122.12, 37.66] },
    properties: {
      icaoId: 'KHWD',
      flightCategory: 'VFR',
      metarObservedAt: '2026-09-12T23:54:00Z',
      metarWindDirection: 'VRB',
      metarWindSpeedKt: 4,
      rawMetar: 'METAR KHWD TEST',
    },
  };
  const rows = featureDetailRows(feature);

  assert.equal(rows.find((row) => row.label === 'Wind')?.value, 'VRB 4 kt');
  assert.equal(formatObservationTime(feature.properties.metarObservedAt, Date.parse('2026-09-18T00:00:00Z')), 'Sep 12 · 23:54Z');
  assert.equal(rows.find((row) => row.label === 'Raw')?.wide, true);
});

test('map selections restore full nested runway data from navigation references', () => {
  const reference: GeoPointFeature = {
    type: 'Feature', id: 'airport:01651.:A',
    geometry: { type: 'Point', coordinates: [-122.12, 37.66] },
    properties: { icaoId: 'KHWD', runways: [{ id: '10R/28L', ends: [
      { id: '10R', trueHeadingDeg: 120, trafficPattern: 'right' },
    ] }] },
  };
  const rendered = { ...reference, properties: { icaoId: 'KHWD' } };
  assert.equal(resolveNavigationFeature(rendered, { airports: {
    type: 'FeatureCollection', features: [reference],
    meta: { revision: '2026-09-03', layer: 'airports', returned: 1, truncated: false },
  } }), reference);
  assert.equal(resolveNavigationFeature(rendered, {}), rendered);
});

test('hydration requires the same feature and export identity, including same-cycle replacements', () => {
  const selected: GeoPointFeature = { type: 'Feature', id: 'airport:KSBA',
    geometry: { type: 'Point', coordinates: [-119.84, 34.43] },
    properties: { ident: 'KSBA', dataRevision: '2026-08-06', dataSourceKey: 'original' } };
  const hydrate = (feature: GeoPointFeature) => resolveNavigationFeature(selected, { airports: {
    type: 'FeatureCollection', features: [feature],
    meta: { revision: feature.properties.dataRevision!, layer: 'airports', returned: 1, truncated: false },
  } });
  const full = { ...selected, properties: { ...selected.properties, runways: [{ id: '07/25' }] } };
  assert.equal(hydrate(full), full);
  for (const dataRevision of ['2026-08-06', '2026-09-03']) {
    const replacement = { ...full, properties: { ...full.properties, dataRevision, dataSourceKey: 'replacement' } };
    assert.equal(hydrate(replacement), selected);
  }
});

test('airport summary leads with elevation and runway length, then local weather and radio frequencies', () => {
  const feature: GeoPointFeature = { type: 'Feature', geometry: { type: 'Point', coordinates: [-122, 37] },
    properties: { kind: 'landing-facility', facilityType: 'A', elevationFt: 170, longestRunwayFt: 3500,
      lowArtcc: 'ZLA', frequencies: [
        { type: 'ATIS', frequencyMHz: 119.15, hours: '0700-2100' },
        { type: 'TOWER', frequencyMHz: 120.1, use: 'LCL/P', hours: '0700-2100' },
        { type: 'TOWER', frequencyMHz: 257.8, use: 'LCL/P' },
        { type: 'CTAF', frequencyMHz: 120.1, remarks: 'WHEN TOWER CLOSED' },
        { type: 'GROUND', frequencyMHz: 121.9, hours: '0700-2100' },
      ] } };
  const rows = featureDetailRows(feature, false);
  assert.deepEqual(rows.map(row => [row.label, row.value]), [
    ['Elevation', '170 ft'], ['Longest runway', '3,500 ft'], ['ATIS', '119.15 MHz'],
    ['Tower / CTAF', '120.10 MHz'], ['Ground', '121.90 MHz'],
  ]);
  assert.deepEqual(rows.find(row => row.label === 'Tower / CTAF')?.notes,
    ['120.10 MHz · Tower hours 0700-2100', '257.80 MHz', '120.10 MHz · WHEN TOWER CLOSED']);
  assert.equal(rows.find(row => row.label === 'ATIS')?.notes, undefined, 'tower hours do not describe ATIS availability');
  assert.equal(rows.find(row => row.label === 'Ground')?.notes, undefined, 'tower hours are shown once under Tower');
});

test('frequency rows retain sectors, secondary channels, and 25 kHz precision without merging different Tower and CTAF channels', () => {
  const feature: GeoPointFeature = { type: 'Feature', geometry: { type: 'Point', coordinates: [-122, 37] },
    properties: { kind: 'airport', frequencies: [
      { type: 'D-ATIS', frequencyMHz: 133.8, sector: 'ARR' },
      { type: 'D-ATIS', frequencyMHz: 135.65, sector: 'DEP' },
      { type: 'TOWER', frequencyMHz: 118.9, use: 'LCL/S' },
      { type: 'TOWER', frequencyMHz: 120.2, use: 'LCL/P', sector: 'RWY 10R/28L' },
      { type: 'CTAF', frequencyMHz: 120.2 },
      { type: 'GROUND', frequencyMHz: 118.025 },
    ] } };
  const rows = featureDetailRows(feature, false);
  assert.deepEqual(rows.map(row => row.label), ['D-ATIS', 'Tower', 'CTAF', 'Ground']);
  assert.equal(rows[0]?.value, '133.80 MHz · ARR\n135.65 MHz · DEP');
  assert.equal(rows[1]?.value, '120.20 MHz · RWY 10R/28L\n118.90 MHz · Secondary');
  assert.equal(rows[3]?.value, '118.025 MHz');
});

test('untowered airports show AWOS or ASOS and CTAF; older exports omit missing frequencies', () => {
  for (const type of ['AWOS', 'ASOS'] as const) {
    const feature: GeoPointFeature = { type: 'Feature', geometry: { type: 'Point', coordinates: [-122, 37] },
      properties: { kind: 'airport', frequencies: [{ type, frequencyMHz: 127.275 }, { type: 'CTAF', frequencyMHz: 122.8 }] } };
    assert.deepEqual(featureDetailRows(feature, false).map(row => row.label), [type, 'CTAF']);
    delete feature.properties.frequencies;
    assert.deepEqual(featureDetailRows(feature, false), []);
  }
});
