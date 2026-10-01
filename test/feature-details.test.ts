import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AirportFrequencyValue } from '../src/layers/navigation/airport-frequency-value';
import { airportFrequencyRows } from '../src/layers/navigation/airport-frequencies';

import type { GeoPointFeature } from '@zlayer/contracts';

import { formatObservationTime } from '../src/layers/metar-taf/metar/format.js';
import { featureDetailRows, resolveNavigationFeature, type FeatureDetailRow } from '../src/layers/navigation/feature-details.js';
import { withMapLabelKeys } from '../src/core/map/label';

function renderFrequency(row: FeatureDetailRow | undefined) {
  assert.ok(row?.frequency);
  return renderToStaticMarkup(createElement(AirportFrequencyValue, { label: row.label, frequency: row.frequency }));
}

function frequencyNotes(row: FeatureDetailRow | undefined) {
  return [...renderFrequency(row).matchAll(/<div class="airport-frequency-note">(.*?)<\/div>/g)]
    .map(match => match[1]!.replace(/<\/span><p>/g, ' · ').replace(/<[^>]*>/g, ''));
}

test('map sources omit nested reference details while retaining styling and exact export identity', () => {
  const feature: GeoPointFeature = { type: 'Feature', id: 'airport:KSBA',
    geometry: { type: 'Point', coordinates: [-119.84, 34.43] },
    properties: { ident: 'KSBA', kind: 'airport', facilityType: 'A', towered: true,
      longestRunwayFt: 6052, dataRevision: '2026-09-03', dataSourceKey: 'export-1',
      runways: [{ id: '07/25' }], frequencies: [{ type: 'TOWER', frequencyMHz: 119.7 }], charts: ['ENROUTE LOW'],
      terminalFrequencies: [{ type: 'CLEARANCE', frequencyMHz: 132.9 }],
      centerFrequencies: [{ type: 'CENTER', frequencyMHz: 127.95, facilityName: 'OAKLAND' }],
      metarStationId: 'KSBA', displayFlightCategory: 'VFR' } };
  const collection = { type: 'FeatureCollection' as const, features: [feature],
    meta: { layer: 'airports' as const, revision: '2026-09-03', returned: 1, truncated: false } };
  const mapped = withMapLabelKeys(collection).features[0]!;
  for (const key of ['runways', 'frequencies', 'terminalFrequencies', 'centerFrequencies', 'charts']) {
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
    ['Ground', '121.90 MHz'], ['Tower / CTAF', '120.10 MHz'],
  ]);
  assert.deepEqual(frequencyNotes(rows.find(row => row.label === 'Tower / CTAF')),
    ['120.10 MHz · CTAF · WHEN TOWER CLOSED', '120.10 MHz · Tower · Tower hours 0700-2100', '257.80 MHz · Tower']);
  assert.deepEqual(frequencyNotes(rows.find(row => row.label === 'ATIS')), [], 'tower hours do not describe ATIS availability');
  assert.deepEqual(frequencyNotes(rows.find(row => row.label === 'Ground')), [], 'tower hours are shown once under Tower');
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
  assert.deepEqual(rows.map(row => row.label), ['D-ATIS', 'Ground', 'Tower', 'CTAF']);
  assert.equal(rows[0]?.value, '133.80 MHz · ARR\n135.65 MHz · DEP');
  assert.equal(rows[2]?.value, '120.20 MHz · RWY 10R/28L\n118.90 MHz · Secondary');
  assert.equal(rows[1]?.value, '118.025 MHz');
});

test('airport radios follow service order and retain clearance and terminal channel qualifications', () => {
  const feature: GeoPointFeature = { type: 'Feature', geometry: { type: 'Point', coordinates: [-122, 37] },
    properties: { kind: 'airport', frequencies: [
      { type: 'GROUND', frequencyMHz: 121.9 }, { type: 'TOWER', frequencyMHz: 120.1 },
      { type: 'ATIS', frequencyMHz: 119.15 },
    ], terminalFrequencies: [
      { type: 'DEPARTURE', frequencyMHz: 125.2, use: 'DEP/P' },
      { type: 'APPROACH', frequencyMHz: 118.025, use: 'APCH/S', sector: 'WEST', remarks: 'SECONDARY SECTOR' },
      { type: 'APPROACH', frequencyMHz: 124.3, use: 'APCH/P', sector: 'EAST', remarks: 'EAST ONLY' },
      { type: 'APPROACH', frequencyMHz: 124.3, use: 'APCH/P', sector: 'NORTH', remarks: 'NORTH ONLY' },
      { type: 'APPROACH', frequencyMHz: 263.025, use: 'APCH/S', sector: 'WEST', remarks: 'UHF SECTOR' },
      { type: 'CLEARANCE', frequencyMHz: 128.05, use: 'CD PRE TAXI CLNC', hours: '0700-2100', remarks: 'BEFORE TAXI' },
      { type: 'APPROACH/DEPARTURE', frequencyMHz: 120.55, use: 'APCH/P DEP/P IC', sector: '151-329' },
    ] } };
  const rows = featureDetailRows(feature, false);
  assert.deepEqual(rows.map(row => row.label), ['ATIS', 'CD', 'Ground', 'Tower', 'Approach', 'App / Dep', 'Departure']);
  assert.equal(rows.find(row => row.label === 'Approach')?.value,
    '124.30 MHz · EAST\n124.30 MHz · NORTH\n118.025 MHz · WEST · Secondary');
  assert.deepEqual(frequencyNotes(rows.find(row => row.label === 'Approach')), [
    '124.30 MHz · EAST · EAST ONLY', '124.30 MHz · NORTH · NORTH ONLY',
    '118.025 MHz · WEST · Secondary · SECONDARY SECTOR', '263.025 MHz · WEST · Secondary · UHF SECTOR',
  ]);
  assert.deepEqual(frequencyNotes(rows.find(row => row.label === 'CD')), ['CD PRE TAXI CLNC · BEFORE TAXI']);
  assert.deepEqual(frequencyNotes(rows.find(row => row.label === 'App / Dep')), ['APCH/P DEP/P IC']);
  assert.equal(rows.find(row => row.label === 'Departure')?.value, '125.20 MHz');
});

test('terminal services without VHF retain their UHF channel in the summary', () => {
  const feature: GeoPointFeature = { type: 'Feature', geometry: { type: 'Point', coordinates: [-122, 37] },
    properties: { kind: 'airport', terminalFrequencies: [{ type: 'DEPARTURE', frequencyMHz: 263.025, use: 'DEP/S' }] } };
  assert.equal(featureDetailRows(feature, false)[0]?.value, '263.025 MHz · Secondary');
});

test('frequency summaries retain facility identity, Center altitude and site notes, including UHF-only service', () => {
  const feature: GeoPointFeature = { type: 'Feature', geometry: { type: 'Point', coordinates: [-122, 37] },
    properties: { kind: 'airport', terminalFrequencies: [
      { type: 'APPROACH', frequencyMHz: 124.3, facilityId: 'SCT', facilityName: 'SOCAL', remarks: 'SOUTH ONLY' },
      { type: 'APPROACH', frequencyMHz: 124.3, facilityId: 'NCT', facilityName: 'NORCAL', remarks: 'NORTH ONLY' },
      { type: 'DEPARTURE', frequencyMHz: 125.2, facilityName: 'SOCAL' },
    ], centerFrequencies: [
      { type: 'CENTER', frequencyMHz: 127.95, facilityId: 'ZOA', facilityName: 'OAKLAND', sector: 'LOW', use: 'SQUAW VALLEY RCAG' },
      { type: 'CENTER', frequencyMHz: 353.7, facilityId: 'ZOA', facilityName: 'OAKLAND', sector: 'HIGH', use: 'SQUAW VALLEY RCAG' },
    ] } };
  const rows = featureDetailRows(feature, false);
  assert.deepEqual(rows.map(row => row.label), ['Approach', 'Departure', 'Center']);
  assert.equal(rows[0]?.value, '124.30 MHz · NORCAL\n124.30 MHz · SOCAL');
  assert.deepEqual(frequencyNotes(rows[0]), ['124.30 MHz · NORCAL · NORTH ONLY', '124.30 MHz · SOCAL · SOUTH ONLY']);
  assert.equal(rows[1]?.value, '125.20 MHz · SOCAL');
  assert.equal(rows[2]?.value, '127.95 MHz · OAKLAND · LOW');
  assert.deepEqual(frequencyNotes(rows[2]), ['127.95 MHz · OAKLAND · LOW · SQUAW VALLEY RCAG', '353.70 MHz · OAKLAND · HIGH · SQUAW VALLEY RCAG']);
  feature.properties.centerFrequencies = [{ type: 'CENTER', frequencyMHz: 353.7, facilityId: 'ZOA' }];
  assert.equal(featureDetailRows(feature, false).at(-1)?.value, '353.70 MHz · ZOA');
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


test('Tower and Ground keep IC qualifiers, share common hours once, and format UHF notes as channels', () => {
  // KCCR-style multiple Tower channels and published LCL/GND IC uses.
  const frequencies = [
    { type: 'TOWER' as const, frequencyMHz: 119.7, use: 'LCL/P IC', hours: '0700-2200' },
    { type: 'TOWER' as const, frequencyMHz: 123.9, use: 'LCL/P', hours: '0700-2200' },
    { type: 'TOWER' as const, frequencyMHz: 257.8, use: 'LCL/P', hours: '0700-2200' },
    { type: 'GROUND' as const, frequencyMHz: 121.9, use: 'GND/P IC', hours: '0700-2200' },
  ];
  const rows = airportFrequencyRows(frequencies);
  const tower = rows.find(row => row.label === 'Tower');
  assert.deepEqual(frequencyNotes(tower), ['Tower hours 0700-2200', '119.70 MHz · LCL/P IC', '257.80 MHz']);
  assert.deepEqual(frequencyNotes(rows.find(row => row.label === 'Ground')), ['GND/P IC']);
  const html = renderFrequency(tower);
  assert.equal(html.split('Tower hours 0700-2200').length - 1, 1);
  assert.match(html, /class="airport-frequency-number">257.80<span class="airport-frequency-unit"> MHz<\/span>/);
  assert.deepEqual(airportFrequencyRows([...frequencies].reverse()), rows, 'source ordering cannot change the presentation');
  assert.deepEqual(airportFrequencyRows([...frequencies, ...frequencies]), rows, 'duplicate inputs do not duplicate channels or notes');
});

test('different or missing Tower schedules stay attributed and Tower/CTAF priorities must agree', () => {
  const rows = airportFrequencyRows([
    { type: 'TOWER', frequencyMHz: 120.1, use: 'LCL/P', hours: '0700-2100' },
    { type: 'TOWER', frequencyMHz: 120.2, use: 'LCL/P', hours: '0800-2000' },
    { type: 'TOWER', frequencyMHz: 257.8, use: 'LCL/P' },
  ]);
  assert.deepEqual(frequencyNotes(rows[0]), [
    '120.10 MHz · Tower hours 0700-2100', '120.20 MHz · Tower hours 0800-2000', '257.80 MHz',
  ]);
  const missing = airportFrequencyRows([
    { type: 'TOWER', frequencyMHz: 120.1, hours: '24' }, { type: 'TOWER', frequencyMHz: 120.2 },
  ]);
  assert.deepEqual(frequencyNotes(missing[0]), ['120.10 MHz · Tower hours 24']);
  const priorities = airportFrequencyRows([
    { type: 'TOWER', frequencyMHz: 120.1, use: 'LCL/S' }, { type: 'CTAF', frequencyMHz: 120.1 },
  ]);
  assert.deepEqual(priorities.map(row => row.label), ['Tower', 'CTAF']);
  assert.deepEqual(frequencyNotes(airportFrequencyRows([
    { type: 'AWOS', frequencyMHz: 127.275, use: 'SMO AWOS-3' },
  ])[0]), ['SMO AWOS-3']);
});


test('same-name providers retain their distinct identities in summaries and notes', () => {
  // The October 1 KMEM feed publishes both M03 and MEM as MEMPHIS on 125.2.
  const records = [
    { type: 'CLEARANCE' as const, frequencyMHz: 125.2, use: 'CD PRE TAXI CLNC', facilityId: 'M03', facilityName: 'MEMPHIS' },
    { type: 'CLEARANCE' as const, frequencyMHz: 125.2, use: 'CD PRE TAXI CLNC', facilityId: 'MEM', facilityName: 'MEMPHIS', hours: '24' },
  ];
  const rows = airportFrequencyRows(records);
  assert.equal(rows[0]?.value, '125.20 MHz · MEMPHIS (M03)\n125.20 MHz · MEMPHIS (MEM)');
  assert.deepEqual(frequencyNotes(rows[0]), [
    '125.20 MHz · MEMPHIS (M03) · CD PRE TAXI CLNC', '125.20 MHz · MEMPHIS (MEM) · CD PRE TAXI CLNC',
  ]);
  assert.deepEqual(airportFrequencyRows([...records].reverse()), rows);
  assert.deepEqual(airportFrequencyRows([...records, ...records]), rows);
  const unknown = airportFrequencyRows([records[0]!, { type: 'CLEARANCE', frequencyMHz: 125.2,
    use: 'CD PRE TAXI CLNC', facilityName: 'MEMPHIS' }]);
  assert.equal(unknown[0]?.value, '125.20 MHz · MEMPHIS\n125.20 MHz · MEMPHIS (M03)');
  const separate = airportFrequencyRows([
    { type: 'TOWER', frequencyMHz: 120.1, facilityName: 'SHARED', facilityId: 'FIRST' },
    { type: 'CTAF', frequencyMHz: 120.1, facilityName: 'SHARED', facilityId: 'SECOND' },
  ]);
  assert.deepEqual(separate.map(row => row.label), ['Tower', 'CTAF']);
});
