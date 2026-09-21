import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  FeatureCollectionResponse,
  MetarFeature,
  MetarFeatureCollection,
} from '@zlayer/contracts';

import {
  latestMetarObservation,
  mergeMetarsIntoAirports,
  metarFlightCategory,
  metarObservationTime,
  metarStationId,
  metarWeatherProperties,
  preferredWeatherStationId,
  setFlightCategoryDisplay,
  weatherStationIdsForAirports,
} from '../src/index.js';

function metar(properties: MetarFeature['properties']): MetarFeature {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [-122.37, 37.62] },
    properties,
  };
}

test('weather-only joins skip non-reporting airports and retain the same matched reports and identities', () => {
  const airports: FeatureCollectionResponse = { type: 'FeatureCollection',
    meta: { revision: 'test', layer: 'airports', returned: 3, truncated: false },
    features: ['KSFO', 'KJFK', 'KOAK'].map(icaoId => ({ type: 'Feature', id: `airport:${icaoId}`,
      geometry: { type: 'Point', coordinates: [-122, 37] }, properties: { icaoId, kind: 'airport',
        // A previously joined report must not qualify an airport on its own.
        metarStationId: icaoId, rawMetar: 'obsolete' } })),
  };
  const reports: MetarFeatureCollection = { type: 'FeatureCollection', features: [
    metar({ id: 'KSFO', obsTime: '2026-09-20T10:00:00Z', fltcat: 'VFR' }),
    metar({ id: 'KOAK', obsTime: '2026-09-20T09:00:00Z', fltcat: 'IFR' }),
    metar({ id: 'KOAK', obsTime: '2026-09-20T11:00:00Z', fltcat: 'MVFR' }),
  ] };
  const original = structuredClone(airports);
  const complete = mergeMetarsIntoAirports(airports, reports);
  const filtered = mergeMetarsIntoAirports(airports, reports, { weatherOnly: true });
  assert.deepEqual(filtered.features, complete.features.filter(feature => feature.properties.metarStationId));
  assert.deepEqual(filtered.features.map(feature => feature.id), ['airport:KSFO', 'airport:KOAK']);
  assert.deepEqual(filtered.features.map(feature => feature.properties.flightCategory), ['VFR', 'MVFR']);
  assert.deepEqual(airports, original);
  assert.equal(mergeMetarsIntoAirports(airports, { type: 'FeatureCollection', features: [] }, { weatherOnly: true }).features.length, 0);
});

test('uses AWC flight category and normalizes its spelling', () => {
  assert.equal(metarFlightCategory(metar({ id: 'KSFO', fltcat: 'vfr' })), 'VFR');
  assert.equal(metarFlightCategory(metar({ id: 'KSFO', fltCat: 'VFR*' })), 'VFR');
  assert.equal(metarFlightCategory(metar({ id: 'KSFO', fltcat: '', fltCat: 'IFR' })), 'IFR');
});

test('derives the most restrictive FAA category from ceiling and visibility', () => {
  assert.equal(
    metarFlightCategory(metar({ id: 'KAAA', visib: 10, clouds: [{ cover: 'OVC', base: 4 }] })),
    'LIFR',
  );
  assert.equal(
    metarFlightCategory(metar({ id: 'KBBB', visib: 2.5, clouds: [{ cover: 'BKN', base: 20 }] })),
    'IFR',
  );
  assert.equal(
    metarFlightCategory(metar({ id: 'KCCC', visib: 5, clouds: [{ cover: 'SCT', base: 8 }] })),
    'MVFR',
  );
  assert.equal(metarFlightCategory(metar({ id: 'KDDD', visib: '1/2' })), 'LIFR');
  assert.equal(metarFlightCategory(metar({ id: 'KEEE', visib: '1 1/2' })), 'IFR');
});

test('decoded METAR ceilings retain GeoJSON units, the lowest ceiling layer, and vertical visibility', () => {
  const cases: [MetarFeature['properties'], number][] = [
    [{ ceil: 9, clouds: [{ cover: 'OVC', base: 20 }] }, 900],
    [{ ceil: 0 }, 0],
    [{ ceil: null, clouds: [{ cover: 'FEW', base: 3 }, { cover: 'OVC', base: 30 }, { cover: ' bkn ', base: 12 }] }, 1200],
    [{ clouds: [{ cover: 'VV', base: 2 }] }, 200],
    [{ clouds: [{ cover: 'OVX', base: 0 }] }, 0],
  ];
  for (const [properties, height] of cases) {
    const decoded = metarWeatherProperties(metar(properties));
    assert.equal(decoded.metarCeilingFt, height);
    assert.equal(decoded.metarCeilingStatus, 'measured');
  }
});

test('ceiling falls back to observation cloud groups without borrowing remarks or forecast trends', () => {
  const cases: [string, number | undefined][] = [
    ['FEW003 BKN012 OVC030', 1200],
    ['BKN020CB BKN015TCU', 1500],
    ['VV002', 200],
    ['OVC000', 0],
    ['BKN/// OVC030', undefined],
    ['VV///', undefined],
    ['RMK BKN002', undefined],
    ['TEMPO BKN002', undefined],
    ['BECMG OVC003', undefined],
    ['BKN0120', undefined],
    ['NOTBKN012', undefined],
  ];
  for (const [sky, height] of cases) {
    const properties = metarWeatherProperties(metar({ id: 'KAAA', ceil: null,
      rawOb: `METAR KAAA 171800Z 28010KT 10SM ${sky}` }));
    assert.equal(properties.metarCeilingFt, height, sky);
    assert.equal(properties.metarCeilingStatus, height === undefined ? 'unknown' : 'measured', sky);
  }
  assert.equal(metarFlightCategory(metar({ visib: 10, rawOb: 'METAR KAAA 171800Z 28010KT 10SM OVC008' })), 'IFR');
});

test('ceiling distinguishes no reported ceiling from missing or unknown cloud observations', () => {
  const clear: MetarFeature['properties'][] = [
    { ceil: null, cover: 'CLR', clouds: [] },
    { clouds: [{ cover: 'FEW', base: 3 }, { cover: 'SCT', base: 20 }] },
    { rawOb: 'METAR KAAA 171800Z 28010KT 10SM SKC RMK BKN002' },
    { rawOb: 'METAR KAAA 171800Z 28010KT 10SM SCT030 TEMPO BKN008' },
    { rawOb: 'METAR KAAA 171800Z 28010KT CAVOK' },
  ];
  const unknown: MetarFeature['properties'][] = [
    {}, { fltcat: 'VFR', ceil: null }, { cover: 'OVC' },
    { clouds: [{ cover: 'BKN', base: null }, { cover: 'OVC', base: 30 }] },
    { ceil: -1, clouds: [{ cover: 'VV', base: -1 }] },
    { rawOb: 'METAR KAAA 171800Z 28010KT 10SM VV///' },
  ];
  for (const [cases, status] of [[clear, 'none'], [unknown, 'unknown']] as const) {
    for (const properties of cases) {
      const decoded = metarWeatherProperties(metar(properties));
      assert.equal(decoded.metarCeilingFt, undefined);
      assert.equal(decoded.metarCeilingStatus, status);
    }
  }
});

test('unknown ceiling bases cannot imply VFR or erase restrictions from known layers and visibility', () => {
  const cases: [MetarFeature['properties'], string | undefined][] = [
    [{ visib: 10 }, undefined],
    [{ visib: 10, cover: 'OVC' }, undefined],
    [{ visib: 10, clouds: [{ cover: 'VV', base: null }] }, undefined],
    [{ visib: 10, rawOb: 'METAR KAAA 171800Z 10SM VV///' }, undefined],
    [{ visib: 10, clouds: [{ cover: 'BKN', base: null }, { cover: 'OVC', base: 8 }] }, 'IFR'],
    [{ visib: 10, rawOb: 'METAR KAAA 171800Z 10SM BKN/// OVC008' }, 'IFR'],
    [{ visib: 10, rawOb: 'METAR KAAA 171800Z 10SM BKN004 OVC///' }, 'LIFR'],
    [{ visib: 10, rawOb: 'METAR KAAA 171800Z 10SM BKN/// OVC030' }, 'MVFR'],
    [{ visib: 10, rawOb: 'METAR KAAA 171800Z 10SM BKN/// OVC080' }, undefined],
    [{ visib: 10, clouds: [{ cover: 'BKN', base: 8 }, { cover: 'OVC', base: null }], rawOb: 'BKN/// OVC///' }, 'IFR'],
    [{ visib: 0.5, rawOb: 'METAR KAAA 171800Z 1/2SM BKN/// OVC030' }, 'LIFR'],
    [{ visib: 10, rawOb: 'METAR KAAA 171800Z 10SM BKN/// RMK OVC008' }, undefined],
  ];
  for (const [properties, category] of cases) {
    const observation = metar(properties);
    const decoded = metarWeatherProperties(observation);
    assert.equal(decoded.metarCeilingStatus, 'unknown', JSON.stringify(properties));
    assert.equal(decoded.metarCeilingFt, undefined, 'a bound must not be displayed as a measured ceiling');
    assert.equal(decoded.flightCategory, category, JSON.stringify(properties));
    assert.equal(metarFlightCategory(observation), category, 'map and card use the same category');
  }
  assert.equal(metarFlightCategory(metar({ visib: 10, cover: 'CLR' })), 'VFR');
  assert.equal(metarFlightCategory(metar({ visib: 10, ceil: 80 })), 'VFR');
  assert.equal(metarFlightCategory(metar({ fltcat: 'MVFR', rawOb: 'BKN///' })), 'MVFR', 'AWC category remains authoritative');
  const recovered = metarWeatherProperties(metar({ visib: 10, clouds: [{ cover: 'BKN', base: null }], rawOb: 'BKN008' }));
  assert.equal(recovered.metarCeilingFt, 800, 'complete raw groups recover missing decoded bases');
  assert.equal(recovered.metarCeilingStatus, 'measured');
  assert.equal(recovered.flightCategory, 'IFR');
});

test('merges the latest METAR into the matching FAA airport', () => {
  const airports: FeatureCollectionResponse = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-122.37, 37.62] },
      properties: { kind: 'airport', faaId: 'SFO', icaoId: 'KSFO', name: 'San Francisco Intl' },
    }],
    meta: { revision: '2026-09-03', layer: 'airports', returned: 1, truncated: false },
  };
  const reports: MetarFeatureCollection = {
    type: 'FeatureCollection',
    features: [
      metar({ id: 'KSFO', obsTime: '2026-09-12T20:56:00Z', fltcat: 'MVFR' }),
      metar({ id: 'KSFO', obsTime: '2026-09-12T21:56:00Z', fltcat: 'VFR', rawOb: 'KSFO TEST' }),
    ],
  };

  const merged = mergeMetarsIntoAirports(airports, reports);
  assert.equal(merged.features[0]?.properties.flightCategory, 'VFR');
  assert.equal(merged.features[0]?.properties.rawMetar, 'KSFO TEST');
  assert.equal(latestMetarObservation(reports), '2026-09-12T21:56:00.000Z');
});

test('preserves a report without a category and displays it as unavailable', () => {
  const airports = airportCollection([{ faaId: 'HWD', icaoId: 'KHWD' }]);
  const reports: MetarFeatureCollection = {
    type: 'FeatureCollection',
    features: [metar({
      id: 'KHWD',
      obsTime: '2026-09-12T21:56:00Z',
      rawOb: 'METAR KHWD TEST',
    })],
  };

  const merged = mergeMetarsIntoAirports(airports, reports);
  const displayed = setFlightCategoryDisplay(merged, true);
  assert.equal(displayed.features[0]?.properties.metarStationId, 'KHWD');
  assert.equal(displayed.features[0]?.properties.rawMetar, 'METAR KHWD TEST');
  assert.equal(displayed.features[0]?.properties.flightCategory, undefined);
  assert.equal(displayed.features[0]?.properties.displayFlightCategory, 'N/A');
});

test('clears old weather properties when the latest collection has no matching report', () => {
  const airports = airportCollection([{
    faaId: 'HWD',
    icaoId: 'KHWD',
    flightCategory: 'VFR',
    displayFlightCategory: 'VFR',
    metarStationId: 'KHWD',
    metarCeilingStatus: 'measured',
    metarCeilingFt: 800,
  }]);
  const merged = mergeMetarsIntoAirports(airports, { type: 'FeatureCollection', features: [] });

  assert.equal(merged.features[0]?.properties.flightCategory, undefined);
  assert.equal(merged.features[0]?.properties.displayFlightCategory, undefined);
  assert.equal(merged.features[0]?.properties.metarStationId, undefined);
  assert.equal(merged.features[0]?.properties.metarCeilingStatus, undefined);
  assert.equal(merged.features[0]?.properties.metarCeilingFt, undefined);
});

test('uses authoritative ICAO station IDs from FAA airports', () => {
  const airports = airportCollection([
    { faaId: 'HWD', icaoId: ' khwd ' },
    { faaId: 'ABC' },
    { faaId: 'ABC' },
  ]);

  assert.deepEqual(weatherStationIdsForAirports(airports), ['KHWD']);
  assert.equal(preferredWeatherStationId(airports.features[0]!), 'KHWD');
  assert.equal(preferredWeatherStationId(airports.features[1]!), undefined);
});

test('report identifiers prefer nonblank report IDs, while airport joins retain FAA aliases', () => {
  assert.equal(metarStationId(metar({ id: ' khwd ', icaoId: 'KSFO' })), 'KHWD');
  assert.equal(metarStationId(metar({ id: ' ', icaoId: ' khwd ' })), 'KHWD');
  assert.equal(metarStationId(metar({ id: '', icaoId: ' ' })), undefined);
  const airports = airportCollection([{ faaId: ' hwd ' }]);
  for (const id of ['HWD', 'KHWD']) {
    const merged = mergeMetarsIntoAirports(airports, { type: 'FeatureCollection', features: [metar({ id, rawOb: 'TEST' })] });
    assert.equal(merged.features[0]!.properties.metarStationId, id);
    assert.equal(merged.features[0]!.properties.rawMetar, 'TEST');
  }
  assert.deepEqual(weatherStationIdsForAirports(airports), [], 'joining an alias must not invent a request station');
});

test('observation parsing preserves ISO, seconds, milliseconds and the existing numeric cutoff', () => {
  const iso = '2026-09-12T21:56:00.000Z';
  const epoch = Date.parse(iso);
  const airports = airportCollection([{ icaoId: 'KHWD' }]);
  for (const obsTime of [iso, epoch / 1000, epoch]) {
    const report = metar({ id: 'KHWD', obsTime });
    const reports: MetarFeatureCollection = { type: 'FeatureCollection', features: [report] };
    assert.equal(metarObservationTime(report), epoch);
    assert.equal(latestMetarObservation(reports), iso);
    assert.equal(mergeMetarsIntoAirports(airports, reports).features[0]!.properties.metarObservedAt, iso);
  }
  assert.equal(metarObservationTime(metar({ obsTime: 10_000_000_000 })), 10_000_000_000_000);
  assert.equal(metarObservationTime(metar({ obsTime: 10_000_000_001 })), 10_000_000_001);
  assert.equal(metarObservationTime(metar({ obsTime: -1 })), -1000);
});

test('unknown observation times remain missing, while epoch zero is still a valid displayed time', () => {
  const airports = airportCollection([{ icaoId: 'KHWD' }]);
  for (const obsTime of [undefined, '', 'not a date', NaN, Infinity, Number.MAX_VALUE]) {
    const report = metar({ id: 'KHWD', rawOb: 'TEST', ...(obsTime === undefined ? {} : { obsTime }) });
    const reports: MetarFeatureCollection = { type: 'FeatureCollection', features: [report] };
    assert.equal(metarObservationTime(report), 0);
    assert.equal(latestMetarObservation(reports), undefined);
    const merged = mergeMetarsIntoAirports(airports, reports).features[0]!;
    assert.equal(merged.properties.metarObservedAt, undefined);
    assert.equal(merged.properties.rawMetar, 'TEST');
  }
  const reports: MetarFeatureCollection = { type: 'FeatureCollection', features: [metar({ id: 'KHWD', obsTime: 0 })] };
  assert.equal(mergeMetarsIntoAirports(airports, reports).features[0]!.properties.metarObservedAt, '1970-01-01T00:00:00.000Z');
});

function airportCollection(
  properties: FeatureCollectionResponse['features'][number]['properties'][],
): FeatureCollectionResponse {
  return {
    type: 'FeatureCollection',
    features: properties.map((airportProperties) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-122.12, 37.66] },
      properties: airportProperties,
    })),
    meta: {
      revision: '2026-09-03',
      layer: 'airports',
      returned: properties.length,
      truncated: false,
    },
  };
}
