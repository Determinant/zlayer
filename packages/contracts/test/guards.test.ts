import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isAirwayDataResponse,
  isCatalogResponse,
  isFeatureCollectionResponse,
  isGeoPointFeature,
  isMetarFeatureCollection,
  isProcedureCatalog,
} from '../src/index.js';

test('accepts a valid catalog and rejects inconsistent navigation records', () => {
  const catalog = {
    schemaVersion: 1,
    generatedAt: '2026-09-12T20:00:00Z',
    revision: '2026-09-03',
    charts: [{
      id: 'vfr-sectional-san-francisco',
      title: 'Sectional · San Francisco',
      kind: 'vfr-sectional',
      revision: '2026-09-03',
      format: 'mbtiles',
      bounds: [-126, 35, -117, 41],
      minZoom: 5,
      maxZoom: 12,
      byteLength: 123_456,
      sha256: 'a'.repeat(64),
      url: '/charts/example.mbtiles',
    }],
    navigation: [{
      id: 'airports',
      title: 'Airports',
      count: 10,
      sourceCount: 20,
      minZoom: 6,
      url: '/nav/airports.geojson',
    }],
    airways: {
      id: 'airways',
      title: 'FAA airways',
      count: 1,
      sourceCount: 1,
      url: '/nav/airways.json',
    },
    procedures: {
      id: 'procedures',
      title: 'Airport procedures',
      cycle: '2609',
      effectiveDate: '2026-09-03',
      expirationDate: '2026-10-01',
      airportCount: 10,
      sourceAirportCount: 3197,
      procedureCount: 50,
      sourceProcedureCount: 24231,
      url: '/procedures/catalog.json',
    },
    weather: [{ id: 'awc.metar', title: 'METAR', status: 'current' }],
  };

  assert.equal(isCatalogResponse(catalog), true);
  assert.equal(isCatalogResponse({
    ...catalog,
    navigation: [{ ...catalog.navigation[0], count: 21 }],
  }), false);
  assert.equal(isCatalogResponse({
    ...catalog,
    charts: [{ ...catalog.charts[0], revision: '2026-10-01' }],
  }), false);
  assert.equal(isCatalogResponse({
    ...catalog,
    procedures: { ...catalog.procedures, procedureCount: 25_000 },
  }), false);
  assert.equal(isCatalogResponse({
    ...catalog,
    procedures: { ...catalog.procedures, effectiveDate: '2026-10-01' },
  }), false);
});

test('validates procedure catalogs and exact combined-volume pages', () => {
  const procedure = {
    id: '2609:KHWD:one',
    kind: 'approach',
    name: 'RNAV (GPS) RWY 28L',
    sortOrder: 53525,
    pdfName: '05015R28L.PDF',
    pdfUrl: 'https://aeronav.faa.gov/d-tpp/2609/05015R28L.PDF',
    namedDestination: null,
    volumeTarget: { volumeId: 'SW2', section: null, printedPage: '94', pageIndex: 219 },
    source: {
      chartSequence: '53525',
      chartCode: 'IAP',
      userAction: null,
      changeNoticeFlag: 'N',
      changeNoticeSection: null,
      changeNoticePage: null,
      procedureId: '23139',
      twoColored: 'N',
      civil: 'C',
      faaComputerCode: null,
      copter: 'N',
      amendmentNumber: '1E',
      amendmentDate: '02/20/2025',
      extraFields: {},
    },
  };
  const catalog = {
    schemaVersion: 1,
    builderVersion: 1,
    cycle: '2609',
    effectiveDate: '2026-09-03',
    expirationDate: '2026-10-01',
    generatedAt: '2026-09-14T20:00:00Z',
    faaPdfBaseUrl: 'https://aeronav.faa.gov/d-tpp/2609/',
    sourceXml: {
      url: 'https://aeronav.faa.gov/d-tpp/2609/xml_data/d-tpp_Metafile.xml',
      sha256: 'a'.repeat(64),
    },
    volumes: [{
      id: 'SW2',
      url: '/chart-data/2026-09-03/tpp-sw2.pdf',
      byteLength: 130_373_606,
      sha256: 'b'.repeat(64),
      pageCount: 560,
      resolvedTargetCount: 1,
      unresolvedTargetCount: 0,
    }],
    airports: [{
      id: 'KHWD',
      faaId: 'HWD',
      icaoId: 'KHWD',
      name: 'HAYWARD EXECUTIVE',
      city: 'HAYWARD',
      state: 'CA',
      volumeId: 'SW2',
      military: false,
      sortCode: '5015',
      procedures: [procedure],
    }],
  };

  assert.equal(isProcedureCatalog(catalog, '2026-09-03'), true);
  assert.equal(isProcedureCatalog(catalog, '2026-10-01'), false);
  assert.equal(isProcedureCatalog({
    ...catalog,
    airports: [{
      ...catalog.airports[0],
      procedures: [{ ...procedure, volumeTarget: { ...procedure.volumeTarget, pageIndex: -1 } }],
    }],
  }), false);
  assert.equal(isProcedureCatalog({
    ...catalog,
    airports: [{
      ...catalog.airports[0],
      procedures: [{ ...procedure, volumeTarget: { ...procedure.volumeTarget, pageIndex: 560 } }],
    }],
  }), false);
});

test('validates revisioned airway paths and segment metadata', () => {
  const document = {
    type: 'ZLayerAirways',
    metadata: { effectiveDate: '2026-09-03', source: 'FAA NASR' },
    airways: [{
      id: 'airway:Y:C:V25',
      ident: 'V25',
      location: 'C',
      regulatory: true,
      points: ['SNS', 'MOVER', 'SFO'],
      segments: [
        { sequence: 10, from: 'SNS', fromType: 'VORTAC', to: 'MOVER', gap: false, meaFt: 4000 },
        { sequence: 20, from: 'MOVER', fromType: 'RP', to: 'SFO', gap: true, meaFt: 5000 },
        { sequence: 30, from: 'SFO', fromType: 'VOR/DME', gap: false, meaFt: 5000 },
      ],
    }],
  };

  assert.equal(isAirwayDataResponse(document, '2026-09-03'), true);
  assert.equal(isAirwayDataResponse(document, '2026-10-01'), false);
  for (const gap of [undefined, 'N', null]) {
    const invalid = structuredClone(document);
    Object.assign(invalid.airways[0]!.segments[0]!, { gap });
    assert.equal(isAirwayDataResponse(invalid), false, 'old or malformed gap flags must not pass validation');
  }
  assert.equal(isAirwayDataResponse({
    ...document,
    airways: [{ ...document.airways[0], points: ['SNS'] }],
  }), false);
});

test('validates navigation identity, geometry, and returned count', () => {
  const collection = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      id: 'airport:KHWD',
      geometry: { type: 'Point', coordinates: [-122.12, 37.66] },
      properties: { icaoId: 'KHWD' },
    }],
    meta: { revision: '2026-09-03', layer: 'airports', returned: 1, truncated: false },
  };

  assert.equal(isFeatureCollectionResponse(collection, 'airports'), true);
  assert.equal(isFeatureCollectionResponse(collection, 'fixes'), false);
  assert.equal(isFeatureCollectionResponse(collection, 'airports', '2026-10-01'), false);
  assert.equal(isFeatureCollectionResponse({
    ...collection,
    meta: { ...collection.meta, returned: 2 },
  }), false);
});

test('rejects malformed METAR GeoJSON', () => {
  assert.equal(isMetarFeatureCollection({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-122.12, 37.66] },
      properties: { id: 'KHWD', fltcat: 'VFR' },
    }],
  }), true);
  assert.equal(isMetarFeatureCollection({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-122.12, 37.66] },
      properties: { id: 'KHWD', fltcat: [] },
    }],
  }), false);
});

test('validates explicit ceiling states while accepting older airport weather fields', () => {
  const feature = { type: 'Feature', geometry: { type: 'Point', coordinates: [-122.1, 37.7] } };
  for (const status of [undefined, 'measured', 'none', 'unknown']) {
    assert.equal(isGeoPointFeature({ ...feature, properties: { metarCeilingStatus: status } }), true);
  }
  for (const status of [null, 'clear', ['none'], 0]) {
    assert.equal(isGeoPointFeature({ ...feature, properties: { metarCeilingStatus: status } }), false);
  }
});

test('rejects invalid values for typed source properties', () => {
  assert.equal(isGeoPointFeature({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [-122.1, 37.7] },
    properties: { towered: 'yes' },
  }), false);
  assert.equal(isMetarFeatureCollection({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-122.1, 37.7] },
      properties: { id: 'KHWD', site: 42 },
    }],
  }), false);
});

test('accepts legacy runway summaries and validates runway-end headings and pattern directions', () => {
  const feature = {
    type: 'Feature', geometry: { type: 'Point', coordinates: [-122, 37] },
    properties: { runways: [{ id: '10R/28L', lengthFt: 5694, widthFt: 150, surface: 'ASPH' }] },
  };
  assert.equal(isGeoPointFeature(feature), true);
  const withEnds = (ends: unknown) => ({ ...feature, properties: {
    runways: [{ ...feature.properties.runways[0], ends }],
  } });
  assert.equal(isGeoPointFeature(withEnds([
    { id: '10R', trueHeadingDeg: 120, trafficPattern: 'right' }, { id: '28L' },
  ])), true);
  for (const heading of [-1, 361, NaN, '120', null]) {
    assert.equal(isGeoPointFeature(withEnds([{ id: '10R', trueHeadingDeg: heading }])), false);
  }
  assert.equal(isGeoPointFeature(withEnds([{ id: '10R', trafficPattern: 'unknown' }])), false);
  assert.equal(isGeoPointFeature(withEnds([{ id: '' }])), false);
  assert.equal(isGeoPointFeature({ ...feature, properties: { runways: '[]' } }), false);
});

test('airport frequencies validate services, channels and optional operational notes while accepting older exports', () => {
  const feature = { type: 'Feature', geometry: { type: 'Point', coordinates: [-122, 37] }, properties: {} };
  const accepts = (frequencies: unknown) => isGeoPointFeature({ ...feature, properties: { frequencies } });
  assert.equal(isGeoPointFeature(feature), true);
  assert.equal(accepts([]), true);
  const valid = { type: 'GROUND', frequencyMHz: 118.025, use: 'GND/P', sector: 'EAST', hours: '24', remarks: 'TEST' };
  assert.equal(accepts([valid]), true);
  for (const frequency of [{ ...valid, frequencyMHz: '118.025' }, { ...valid, frequencyMHz: NaN },
    { ...valid, frequencyMHz: 0 }, { ...valid, type: 'UNICOM' }, { ...valid, hours: 24 }]) {
    assert.equal(accepts([frequency]), false);
  }
  assert.equal(accepts('{}'), false);
});
