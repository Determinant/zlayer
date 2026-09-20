import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  GeoPointFeature,
  ProcedureAirport,
  ProcedureCatalog,
  ProcedureRecord,
  ProcedureResourceRecord,
  ChartSupplementCatalog,
} from '@zlayer/contracts';

import { createPlatesController } from '../src/layers/plates/layer.js';
import type { ProcedureSelection } from '../src/layers/plates/data.js';
import { airportPlateGroups } from '../src/layers/plates/groups.js';
import { fetchChartSupplements, supplementSelections } from '../src/layers/plates/supplements.js';
import { withRegionPlates } from '../src/layers/plates/offline.js';
import { fetchProcedureCatalog } from '../src/layers/plates/api';
import { createBrowserDownloads } from '../src/offline/browser-downloads';
import { cacheFixture } from './helpers/cache';
import { procedureCatalogGuard } from '../src/core/data/references';
import { jsonIdentity } from '../src/core/data/json-identity';
import { bookUrl, type CatalogResponse } from '@zlayer/contracts';
import type { DownloadPlan } from '../src/offline/downloads';
import { OFFLINE_REGIONS } from '../src/offline/regions';

import {
  findProcedureAirport,
  groupProcedures,
  procedureDocument,
} from '../src/layers/plates/data.js';

const approach: ProcedureRecord = {
  id: 'approach',
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
    changeNoticeFlag: null,
    changeNoticeSection: null,
    changeNoticePage: null,
    procedureId: '23139',
    twoColored: null,
    civil: null,
    faaComputerCode: null,
    copter: null,
    amendmentNumber: '1E',
    amendmentDate: '02/20/2025',
    extraFields: {},
  },
};
const deleted: ProcedureRecord = {
  ...approach,
  id: 'deleted',
  name: 'OLD APPROACH',
  source: { ...approach.source, userAction: 'D' },
};
const airport: ProcedureAirport = {
  id: 'KHWD',
  faaId: 'HWD',
  icaoId: 'KHWD',
  name: 'HAYWARD EXECUTIVE',
  city: 'HAYWARD',
  state: 'CA',
  volumeId: 'SW2',
  military: false,
  sortCode: '5015',
  procedures: [approach, deleted],
};
const catalog: ProcedureCatalog = {
  schemaVersion: 1,
  builderVersion: 1,
  cycle: '2609',
  effectiveDate: '2026-09-03',
  expirationDate: '2026-10-01',
  generatedAt: '2026-09-14T20:00:00Z',
  faaPdfBaseUrl: 'https://aeronav.faa.gov/d-tpp/2609/',
  sourceXml: { url: 'test', sha256: 'a'.repeat(64) },
  volumes: [{
    id: 'SW2',
    url: '/chart-data/2026-09-03/tpp-sw2.pdf',
    byteLength: 130_373_606,
    sha256: 'b'.repeat(64),
    pageCount: 560,
    resolvedTargetCount: 2,
    unresolvedTargetCount: 0,
  }],
  airports: [airport],
};
const feature: GeoPointFeature = {
  type: 'Feature',
  id: 'airport:5015',
  geometry: { type: 'Point', coordinates: [-122.12, 37.66] },
  properties: { faaId: 'HWD', icaoId: 'KHWD' },
};

test('a saved TPP export rejects a replacement build with the same dates and counts', async t => {
  const { stored } = cacheFixture(t);
  const resource: ProcedureResourceRecord = { id: 'procedures', title: 'Plates', cycle: catalog.cycle,
    effectiveDate: catalog.effectiveDate, expirationDate: catalog.expirationDate,
    airportCount: 1, sourceAirportCount: 1, procedureCount: 2, sourceProcedureCount: 2,
    url: `https://charts.test/build-identity/catalog.json?v=${encodeURIComponent(catalog.generatedAt)}` };
  const replacement = { ...catalog, generatedAt: '2026-09-17T00:00:00Z',
    volumes: catalog.volumes.map(volume => ({ ...volume, url: '/replacement.pdf', sha256: 'c'.repeat(64) })) };
  assert.equal(procedureCatalogGuard(resource)(replacement), false);
  const pinned = { ...resource, jsonSha256: jsonIdentity(catalog) };
  assert.equal(procedureCatalogGuard(pinned)({ ...replacement, generatedAt: catalog.generatedAt }), false,
    'content-pinned selections reject changed books even if the timestamp was reused');
  stored.set(resource.url, Response.json(replacement));
  const manager = createBrowserDownloads(async () => {});
  assert.equal(await manager.backend.referencesReady({ id: 'build-identity', regionId: 'us-CA', title: 'California',
    revision: catalog.effectiveDate, files: [], references: [resource] }), false);
  t.mock.method(globalThis, 'fetch', async () => Response.json(replacement));
  await assert.rejects(fetchProcedureCatalog(resource), /invalid document/);
  assert.equal(stored.has(resource.url), false, 'a replacement cannot be cached under the saved export URL');
  t.mock.method(globalThis, 'fetch', async () => Response.json(catalog));
  assert.deepEqual(await fetchProcedureCatalog(resource), catalog, 'the exact saved build remains retryable');
});

test('offline plate verification and ordinary loading enforce the same manifest expectations', async t => {
  const { stored } = cacheFixture(t);
  const resource: ProcedureResourceRecord = { id: 'procedures', title: 'Plates', cycle: catalog.cycle,
    effectiveDate: catalog.effectiveDate, expirationDate: catalog.expirationDate,
    airportCount: 1, sourceAirportCount: 1, procedureCount: 2, sourceProcedureCount: 2,
    url: `https://charts.test/tpp/catalog.json?v=${encodeURIComponent(catalog.generatedAt)}` };
  const manager = createBrowserDownloads(async () => { throw new Error('No PDF transfer during verification'); });
  const selection = (reference: ProcedureResourceRecord): DownloadPlan => ({
    id: 'guard-test', regionId: 'us-CA', title: 'California', revision: catalog.effectiveDate, files: [], references: [reference],
  });
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(catalog));
  for (const change of [
    { cycle: '2610' }, { expirationDate: '2026-10-29' },
    { airportCount: 2, sourceAirportCount: 2 }, { procedureCount: 3, sourceProcedureCount: 3 },
  ]) {
    const expected = { ...resource, ...change };
    stored.set(resource.url, Response.json(catalog));
    assert.equal(await manager.backend.referencesReady(selection(expected)), false);
    await assert.rejects(fetchProcedureCatalog(expected), /invalid document/);
    assert.equal(stored.has(resource.url), false);
  }
  stored.set(resource.url, Response.json(catalog));
  assert.equal(await manager.backend.referencesReady(selection(resource)), true);
  assert.deepEqual(await fetchProcedureCatalog(resource), catalog);
  assert.equal(fetch.mock.calls.length, 4, 'verification and the valid ordinary load are cache-only');
});

test('finds an airport and groups only current procedures', () => {
  assert.equal(findProcedureAirport(catalog, feature), airport);
  for (const properties of [{ icaoId: ' khwd ' }, { faaId: ' hwd ' }, { ident: ' hwd ' }]) {
    assert.equal(findProcedureAirport(catalog, { ...feature, properties }), airport);
  }
  assert.deepEqual(groupProcedures(airport).map((group) => [
    group.title,
    group.procedures.map((procedure) => procedure.id),
  ]), [['Approaches', ['approach']]]);
});

const supplements: ChartSupplementCatalog = {
  schemaVersion: 1, builderVersion: 1, generatedAt: catalog.generatedAt,
  effectiveDate: '2026-09-03', expirationDate: '2026-10-29', sourceXml: catalog.sourceXml,
  volumes: [{ id: 'SW', url: '../cs-sw.pdf', pageCount: 831, byteLength: 49_209_653, sha256: 'c'.repeat(64) }],
  airports: [{ faaId: 'HWD', name: 'HAYWARD EXEC', city: 'HAYWARD', state: 'CALIFORNIA',
    volumeId: 'SW', printedPage: '174', pageIndex: 175 }],
};
const supplementResource = { catalog: supplements, url: '/chart-data/2026-09-03/cs/catalog.json' };

test('procedures and supplements use the same normalized feature aliases', () => {
  const selected = { ...feature, properties: { icaoId: ' ', faaId: ' hwd ', ident: 'HWD' } };
  const groups = airportPlateGroups(selected, { catalog, url: '/procedures/catalog.json' },
    supplementResource, 'https://zlayer.test/');
  assert.deepEqual(groups.map(group => group.id), ['airport-diagram', 'approach']);
  assert.equal(groups[0]!.plates[0]!.selection.procedure.name, 'Chart Supplement');
  assert.equal(groups[0]!.plates[0]!.selection.airport.id, 'HWD');
  assert.equal(groups[1]!.plates[0]!.selection.procedure.id, approach.id);
});

test('supplement selections prefer normalized ICAO and fall back to the matched catalog airport', () => {
  for (const [properties, expected] of [
    [{ icaoId: ' khwd ', faaId: ' hwd ' }, 'KHWD'],
    [{ icaoId: ' ', faaId: 'HWD' }, 'HWD'],
    [{ icaoId: '', faaId: 'OTHER', ident: 'HWD' }, 'HWD'],
    [{ ident: ' hwd ' }, 'HWD'],
  ] as const) {
    const rows = supplementSelections(supplements, { ...feature, properties }, supplementResource.url, 'https://zlayer.test/');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.selection.airport.id, expected);
    assert.equal(rows[0]!.selection.procedure.id, 'cs:HWD:SW:175');
  }
});

test('saved supplement metadata stays independent of refreshed catalogs and requires its exact books', async t => {
  const { stored } = cacheFixture(t);
  const url = 'https://charts.test/2026-09-03/cs/catalog.json';
  const volume = supplements.volumes[0]!;
  const plan: DownloadPlan = { id: 'supplements', regionId: 'us-CA', title: 'California', revision: '2026-09-03',
    files: [{ kind: 'pdf', url: bookUrl(volume, url), byteLength: volume.byteLength, sha256: volume.sha256 }],
    references: [{ id: 'chart-supplements', url, snapshot: supplements }],
  };
  const manager = createBrowserDownloads(async () => {});
  stored.set(url, Response.json({ ...supplements, volumes: [{ ...volume, sha256: 'd'.repeat(64) }] }));
  assert.equal(await manager.backend.referencesReady(plan), true);
  stored.clear();
  assert.equal(await manager.backend.referencesReady(plan), true, 'the saved page targets are self-contained');
  assert.equal(await manager.backend.referencesReady({ ...plan, files: [] }), false);
  assert.equal(await manager.backend.referencesReady({ ...plan,
    files: [{ ...plan.files[0]!, kind: 'pdf', sha256: 'd'.repeat(64), byteLength: volume.byteLength }],
  }), false);
  assert.equal(await manager.backend.referencesReady({ ...plan, revision: '2026-11-26' }), false);
});

test('regional plates include individual-only PDFs, share books, and reject genuinely unresolved book targets', () => {
  const region = OFFLINE_REGIONS.find(region => region.code === 'CA')!;
  const plan: DownloadPlan = { id: 'bay', regionId: 'bay', title: 'Bay', revision: catalog.effectiveDate, files: [], references: [] };
  const feed: CatalogResponse = { schemaVersion: 1, revision: catalog.effectiveDate, generatedAt: catalog.generatedAt,
    charts: [], navigation: [], weather: [], procedures: { id: 'procedures', title: 'Plates', cycle: catalog.cycle,
      effectiveDate: catalog.effectiveDate, expirationDate: catalog.expirationDate, airportCount: 1, sourceAirportCount: 1,
      procedureCount: 2, sourceProcedureCount: 2, url: '/chart-data/2026-09-03/tpp/catalog.json' } };
  // Pacific procedures and supplements intentionally reference the same physical book.
  const sharedBook = { ...catalog.volumes[0]!, url: 'https://charts.test/cs-pac.pdf' };
  const sharedSupplements = { ...supplements, volumes: [{ ...sharedBook, id: 'SW' }] };
  const index = { airports: [feature], procedures: { ...catalog, volumes: [sharedBook] }, supplements: sharedSupplements };
  const result = withRegionPlates(plan, region, index, feed, 'https://zlayer.test/');
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0]!.byteLength, catalog.volumes[0]!.byteLength);
  assert.match(result.files[0]!.url, /sha256=b{64}/);
  assert.equal(result.references.length, 2);
  assert.equal(withRegionPlates(plan, OFFLINE_REGIONS.find(region => region.code === 'NY')!, index, feed, 'https://zlayer.test/').files.length, 0);
  assert.equal(withRegionPlates(plan, region, { ...index, airports: [] }, feed, 'https://zlayer.test/').files.length, 1,
    'catalog state membership includes books even when NASR has no matching airport');
  assert.equal(result.id, plan.id, 'adding mandatory books preserves the full-region selection identity');
  assert.equal(withRegionPlates(plan, region, { ...index,
    airports: [{ ...feature, geometry: { type: 'Point', coordinates: [-119.7681, 39.4991] }, properties: { ...feature.properties, state: 'NV' } }],
    procedures: { ...index.procedures, airports: [{ ...airport, state: 'NV' }] },
    supplements: { ...sharedSupplements, airports: [{ ...supplements.airports[0]!, state: 'NEVADA' }] },
  }, feed, 'https://zlayer.test/').files.length, 0, 'neighboring state books are not selected merely by the chart rectangle');
  const pacific = { ...index,
    airports: [{ ...feature, geometry: { type: 'Point' as const, coordinates: [144.8, 13.49] as [number, number] }, properties: { ...feature.properties, state: 'GU' } }],
    procedures: { ...index.procedures, airports: [{ ...airport, state: 'XX' }] },
    supplements: { ...sharedSupplements, airports: [{ ...supplements.airports[0]!, state: 'GUAM' }] },
  };
  assert.equal(withRegionPlates(plan, OFFLINE_REGIONS.find(r => r.code === 'GU')!, pacific, feed, 'https://zlayer.test/').files.length, 1,
    'Pacific XX procedures use NASR territory membership and share their supplement book');
  const missing = { ...catalog, airports: [{ ...airport, procedures: [{ ...approach, volumeTarget: null }] }] };
  const fallbackPlan = withRegionPlates(plan, region, { ...index, procedures: missing }, feed, 'https://zlayer.test/');
  const fallback = fallbackPlan.files.find(file => file.kind === 'faa-pdf')!;
  assert.equal(fallback.url, procedureDocument(missing, missing.airports[0]!.procedures[0]!, feed.procedures!.url, 'https://zlayer.test/').url,
    'regional downloads and the PDF.js viewer must share exactly one cache key');
  assert.equal(fallback.byteLength, undefined, 'do not invent a size or publisher checksum');
  const shared = { ...missing, airports: [...missing.airports, { ...missing.airports[0]!, id: 'KOTHER' }] };
  assert.equal(withRegionPlates(plan, region, { ...index, procedures: shared }, feed, 'https://zlayer.test/')
    .files.filter(file => file.kind === 'faa-pdf').length, 1, 'shared individual PDFs are downloaded once');
  const unresolved = { ...catalog, airports: [{ ...airport, procedures: [{ ...approach,
    volumeTarget: { ...approach.volumeTarget!, pageIndex: null } }] }] };
  assert.throws(() => withRegionPlates(plan, region, { ...index, procedures: unresolved }, feed, 'https://zlayer.test/'), /unresolved book page/);
});

test('places CS immediately after airport diagrams and before approaches, with its own dates', () => {
  const withDiagram = { ...catalog, airports: [{ ...airport, procedures: [approach,
    { ...approach, id: 'diagram', kind: 'airport-diagram' as const, name: 'AIRPORT DIAGRAM' }] }] };
  const groups = airportPlateGroups(feature,
    { catalog: withDiagram, url: '/chart-data/2026-09-03/tpp/catalog.json' }, supplementResource, 'http://localhost/');
  assert.deepEqual(groups.map(g => [g.title, g.plates.map(p => p.selection.procedure.name)]), [
    ['Airport', ['AIRPORT DIAGRAM', 'Chart Supplement']], ['Approaches', ['RNAV (GPS) RWY 28L']],
  ]);
  const cs = groups[0]!.plates[1]!.selection;
  assert.equal(cs.document.source, 'chart-supplement');
  assert.equal(cs.document.pageIndex, 175);
  assert.equal(cs.document.nativeUrl.endsWith('#page=176'), true);
  assert.equal(new URL(cs.document.url).pathname, '/chart-data/2026-09-03/cs-sw.pdf');
  assert.equal(new URL(cs.document.url).searchParams.get('sha256'), 'c'.repeat(64));
  assert.equal(cs.expirationDate, '2026-10-29');
  assert.equal(groups[0]!.plates[1]!.detail, 'CS SW · Page 174');
});

test('CS is available without TPPs or an airport diagram; different airports share one book cache key', () => {
  const groups = airportPlateGroups(feature, undefined, supplementResource, 'http://localhost/');
  assert.deepEqual(groups.map(g => g.title), ['Airport']);
  const hwd = groups[0]!.plates[0]!.selection.document;
  const other = { ...supplements, airports: [{ ...supplements.airports[0]!, faaId: 'SQL', printedPage: '219', pageIndex: 220 }] };
  const sql = airportPlateGroups({ ...feature, properties: { faaId: 'SQL' } }, undefined,
    { ...supplementResource, catalog: other }, 'http://localhost/')[0]!.plates[0]!.selection.document;
  assert.equal(hwd.url, sql.url);
  assert.notEqual(hwd.pageIndex, sql.pageIndex);
  assert.deepEqual(airportPlateGroups({ ...feature, properties: { faaId: 'ZZZ' } }, undefined,
    supplementResource, 'http://localhost/'), []);
});

test('supplement metadata coalesces, revalidates, retries missing feeds, and never preloads PDFs', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let missing = true;
  let requests = 0;
  globalThis.fetch = async (input, init) => {
    requests++;
    assert.equal(String(input).endsWith('/cs/catalog.json'), true);
    assert.equal(init?.cache, 'no-store');
    return missing ? new Response(null, { status: 404 }) : Response.json(supplements);
  };
  assert.equal(await fetchChartSupplements('2026-09-03'), undefined);
  missing = false;
  const [a, b] = await Promise.all([fetchChartSupplements('2026-09-03'), fetchChartSupplements('2026-09-03')]);
  assert.equal(a, b);
  assert.deepEqual(a, supplements);
  assert.equal(requests, 2);
});

test('rejects failed or invalid supplement feeds and allows retry', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(null, { status: 503 });
  await assert.rejects(fetchChartSupplements('2026-10-01'), /503/);
  globalThis.fetch = async () => Response.json({ ...supplements, expirationDate: '2026-10-01' });
  await assert.rejects(fetchChartSupplements('2026-10-01'), /Chart Supplement catalog returned an invalid document/);
  globalThis.fetch = async () => Response.json(supplements);
  assert.deepEqual(await fetchChartSupplements('2026-10-01'), supplements);
});

test('prefers a verified combined-volume page over the individual URL', () => {
  assert.deepEqual(procedureDocument(
    catalog,
    approach,
    '/chart-data/2026-09-03/tpp/catalog.json',
    'http://localhost:4173/',
  ), {
    url: `http://localhost:4173/chart-data/2026-09-03/tpp-sw2.pdf?sha256=${'b'.repeat(64)}&bytes=130373606`,
    nativeUrl: `http://localhost:4173/chart-data/2026-09-03/tpp-sw2.pdf?sha256=${'b'.repeat(64)}&bytes=130373606#page=220`,
    pageIndex: 219,
    pageCount: 560,
    byteLength: 130_373_606,
    sha256: 'b'.repeat(64),
    source: 'combined-volume',
  });
});

test('resolves relative FAA fallbacks and encodes named destinations', () => {
  const fallback = {
    ...approach,
    pdfUrl: '05015R28L.PDF',
    namedDestination: 'HWD MINIMUMS',
    volumeTarget: null,
  };
  assert.deepEqual(procedureDocument(
    catalog,
    fallback,
    '/chart-data/2026-09-03/tpp/catalog.json',
    'http://localhost:4173/',
  ), {
    url: 'https://aeronav.faa.gov/d-tpp/2609/05015R28L.PDF?v=2026-09-14T20%3A00%3A00Z',
    nativeUrl: 'https://aeronav.faa.gov/d-tpp/2609/05015R28L.PDF#nameddest=HWD%20MINIMUMS',
    pageIndex: 0,
    namedDestination: 'HWD MINIMUMS',
    source: 'faa-individual',
  });
});


test('plates owns selection and ignores a closing callback from a replaced plate', () => {
  const layer = createPlatesController();
  const selection: ProcedureSelection = {
    airport,
    procedure: approach,
    document: procedureDocument(catalog, approach, '/tpp/catalog.json', 'http://localhost/'),
    cycle: catalog.cycle,
    effectiveDate: catalog.effectiveDate,
    expirationDate: catalog.expirationDate,
  };
  let changes = 0;
  const unsubscribe = layer.subscribe(() => { changes += 1; });
  assert.equal(layer.getSnapshot().selection, undefined);
  layer.open(selection);
  const first = layer.getSnapshot();
  const replacement = { ...selection, procedure: { ...approach, id: 'another-plate' } };
  layer.open(replacement);
  const second = layer.getSnapshot();
  assert.equal(second.selection, replacement);
  assert.notEqual(second.requestId, first.requestId);
  layer.close(first.requestId);
  assert.equal(layer.getSnapshot(), second);
  assert.equal(changes, 2);
  layer.close(second.requestId);
  assert.equal(layer.getSnapshot().selection, undefined);
  layer.close();
  assert.equal(changes, 3);
  unsubscribe();
  layer.open(selection);
  assert.ok(layer.getSnapshot().requestId > second.requestId);
  assert.equal(changes, 3);
});
