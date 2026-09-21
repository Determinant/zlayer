import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { crc32, deflateSync, gzipSync } from 'node:zlib';
import initSqlJs from 'sql.js';

// Tiny synthetic data, plus NOAA's magnetic model. Fixtures never enter the app build.
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
  size.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([size, body, checksum]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(256); header.writeUInt32BE(256, 4); header[8] = 8; header[9] = 6;
const pixels = Buffer.alloc(256 * (1 + 256 * 4), 210);
for (let y = 0; y < 256; y++) {
  const offset = y * 1025; pixels[offset] = 0;
  for (let x = 0; x < 256; x++) pixels[offset + 4 + x * 4] = 255;
}
export const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0))]);
function pdf(georeferenced = false) {
  const drawing = '0.1 0.3 0.8 rg 20 20 160 160 re f\n' +
    '1 0 0 rg 20 145 35 35 re f\n0 1 0 rg 145 145 35 35 re f\n1 1 0 rg 20 20 35 35 re f';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [3 0 R${georeferenced ? ' 6 0 R' : ''}] /Count ${georeferenced ? 2 : 1} >>`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R ' +
      (georeferenced ? '/VP [<< /BBox [0 0 200 200] /Measure << /Type /Measure /Subtype /GEO ' +
        '/Bounds [0 0 1 0 1 1 0 1] /LPTS [0 0 1 0 1 1 0 1] /GPTS [34.3 -120 34.3 -119.7 34.6 -119.7 34.6 -120] ' +
        '/GCS << /Type /GEOGCS /WKT (GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]) >> >> >>] ' : '') + '>>',
    `<< /Length ${drawing.length} >>\nstream\n${drawing}\nendstream`,
    // An unused object makes this large enough to exercise PDF.js range loading.
    `<< /Length 262144 >>\nstream\n${' '.repeat(262144)}\nendstream`,
  ];
  if (georeferenced) objects.push(objects[2]);
  let text = '%PDF-1.7\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(text));
    text += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(text);
  text += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) text += `${String(offset).padStart(10, '0')} 00000 n \n`;
  return Buffer.from(text + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

export async function fixtureFiles() {
  const files = new Map();
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run('CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)');
  db.run('INSERT INTO tiles VALUES (0, 0, 0, ?)', [png]);
  const chart = Buffer.from(db.export());
  db.close();
  const archiveId = 'vfr-sectional-z0-r0-0-0';
  const archiveFile = `${archiveId}-${hash(chart)}.mbtiles`;
  const book = pdf();
  const historyFixture = JSON.parse(await readFile(new URL('../fixtures/route-history.json', import.meta.url), 'utf8'));
  const magneticFixture = JSON.parse(await readFile(new URL('../fixtures/magnetic-model.json', import.meta.url), 'utf8'));
  const add = (path, value, type = 'application/json') => files.set(path, {
    body: Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)), type,
  });
  const obstacles = { type: 'FeatureCollection', features: [
    [-122.26, 37.5, 500, 'N', 1, 'TOWER'], [-122.12, 37.5, 2000, 'H', 1, 'TOWER'],
    [-121.98, 37.5, 1000, 'R', 1, 'TOWER'], [-122.26, 37.45, 1500, 'S', 2, 'TOWER'],
    [-122.12, 37.45, 350, 'M', 1, 'WIND TURBINE'], [-121.98, 37.45, 500, 'H', 2, 'WIND TURBINE'],
    [-122.12, 37.6, 800, 'N', 1, 'TOWER'], [-122.12, 37.66, 2500, 'H', 1, 'TOWER'],
    [-121.98, 37.6, 1999, 'N', 1, 'TOWER'], [-122.26, 37.6, 499, 'N', 1, 'TOWER'],
  ].map(([lon, lat, height, lighting, quantity, type], index) => ({ type: 'Feature', id: `06-${String(index + 1).padStart(6, '0')}`,
    geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { heightAglFt: height, elevationMslFt: height + 125,
      verified: index !== 3, quantity, structureType: type, lightingCode: lighting } })) };
  const obstacleJson = JSON.stringify(obstacles), obstacleGzip = gzipSync(obstacleJson), obstacleHash = hash(obstacleGzip);
  const obstaclePath = `obstacles-${obstacleHash}.geojson.gz`;
  add(`/chart-data/obstacles/${obstaclePath}`, obstacleGzip, 'application/gzip');
  add('/chart-data/obstacles/manifest.json', { schemaVersion: 1, generatedAt: '2026-09-19T00:00:00Z', horizontalDatum: 'WGS84',
    source: { name: 'Synthetic FAA DOF', lastModified: '2026-09-18T00:00:00Z' }, dataset: { path: obstaclePath, sha256: obstacleHash,
      format: 'geojson', compression: 'gzip', bytes: obstacleGzip.length, uncompressedBytes: Buffer.byteLength(obstacleJson), count: obstacles.features.length } });
  add('/chart-data/cycles.json', { schemaVersion: 1, generatedAt: '2026-09-03T00:00:00Z',
    cycles: ['2026-09-03', '2026-08-06'] });
  for (const revision of ['2026-08-06', '2026-09-03']) {
    const root = `/chart-data/${revision}`;
    const expirationDate = revision === '2026-08-06' ? '2026-09-03' : '2026-10-01';
    const cycle = revision === '2026-08-06' ? '2608' : '2609';
    const generatedAt = `${revision}T00:00:00Z`;
    const metadata = { effectiveDate: revision, source: 'Synthetic browser test' };
    const features = [['KSBA', -119.84, 34.43, 'CA'], ['KSMO', -118.45, 34.02, 'CA'],
      ['KRNO', -119.7681, 39.4991, 'NV']].map(([ident, x, y, state]) => ({
      type: 'Feature', id: `airport:${ident}`, geometry: { type: 'Point', coordinates: [x, y] },
      properties: { ident, icaoId: ident, faaId: ident.slice(1), kind: 'landing-facility',
        name: `${ident} TEST AIRPORT`, state, facilityType: 'AIRPORT', use: 'PUBLIC' },
    }));
    const navaids = [{
      type: 'Feature', id: 'navaid:CMA', geometry: { type: 'Point', coordinates: [-119.093, 34.213] },
      properties: { ident: 'CMA', kind: 'navaid', type: 'VOR/DME', name: 'CAMARILLO',
        state: 'CA', frequency: '115.8', stationDeclinationDeg: 15 },
    }];
    const products = [];
    products.push({ id: 'magnetic-model', file: 'magnetic-model.json', count: 90 });
    add(`${root}/nav/magnetic-model.json`, { ...magneticFixture, effectiveDate: revision });
    for (const id of ['airports', 'fixes', 'navaids', 'vfr-waypoints']) {
      const selected = id === 'airports' ? features : id === 'navaids' ? navaids : [];
      products.push({ id, file: `${id}.geojson`, count: selected.length });
      add(`${root}/nav/${id}.geojson`, { type: 'FeatureCollection', metadata, features: selected });
    }
    products.push({ id: 'airways', file: 'airways.json', count: 0 });
    add(`${root}/nav/airways.json`, { type: 'ZLayerAirways', metadata, airways: [] });
    const routes = ['L', 'TEC'].map((routeType, i) => ({ id: `preferred-route:SBA:SMO:${routeType}:${i + 1}`, originId: 'SBA', destinationId: 'SMO',
      routeType, routeNumber: i + 1, route: 'SBA SMO', segments: [], ...(routeType === 'TEC' ? { designator: 'SBAP12' } : {}) }));
    products.push({ id: 'preferred-routes', file: 'preferred-routes.json', count: routes.length });
    add(`${root}/nav/preferred-routes.json`, { type: 'ZLayerPreferredRoutes', metadata, routes });
    const history = { ...historyFixture.history, effectiveDate: revision };
    const json = Buffer.from(JSON.stringify(history));
    const compressed = gzipSync(json);
    products.push({ ...historyFixture.resource, file: 'route-history.json.gz', bytes: compressed.length, uncompressedBytes: json.length });
    add(`${root}/nav/route-history.json.gz`, compressed, 'application/gzip');
    add(`${root}/nav/manifest.json`, { schemaVersion: 1, effectiveDate: revision, generatedAt, products });
    add(`${root}/mbtiles/chart.mbtiles`, chart, 'application/octet-stream');
    add(`${root}/mbtiles/${archiveFile}`, chart, 'application/octet-stream');
    add(`${root}/mbtiles/manifest.json`, {
      schemaVersion: 2, packagingVersion: 1, effectiveDate: revision, generatedAt, maximumArchiveBytes: 4194304,
      charts: [{ id: 'chart', title: 'Test sectional', kind: 'vfr-sectional', file: 'chart.mbtiles',
        bounds: [-125, 32, -114, 42], minZoom: 0, maxZoom: 0, byteLength: chart.length, sha256: hash(chart), cutlineProvenance: 'test' }],
      archives: [{ id: archiveId, kind: 'vfr-sectional', zoom: 0, root: { z: 0, x: 0, y: 0 },
        file: archiveFile, byteLength: chart.length, sha256: hash(chart), bounds: [-180, -85.0511287798066, 180, 85.0511287798066], tileMask: '1' }],
      regions: [{ id: 'west', title: 'West', bounds: [[-125, 32, -114, 42]], archiveIds: ['vfr-sectional-z0-r0-0-0'] }],
    });
    const volume = { url: '../book.pdf', byteLength: book.length, sha256: hash(book), pageCount: 1 };
    const source = Object.fromEntries(['userAction', 'changeNoticeFlag', 'changeNoticeSection', 'changeNoticePage',
      'procedureId', 'twoColored', 'civil', 'faaComputerCode', 'copter', 'amendmentNumber', 'amendmentDate'].map(key => [key, null]));
    add(`${root}/book.pdf`, book, 'application/pdf');
    add(`${root}/tpp/manifest.json`, { schemaVersion: 1, cycle, effectiveDate: revision, expirationDate, generatedAt, airportCount: 1, procedureCount: 1 });
    add(`${root}/tpp/catalog.json`, {
      schemaVersion: 1, builderVersion: 1, cycle, effectiveDate: revision, expirationDate, generatedAt,
      faaPdfBaseUrl: `https://aeronav.faa.gov/d-tpp/${cycle}/`, sourceXml: { url: 'test', sha256: 'a'.repeat(64) },
      volumes: [{ ...volume, id: 'SW2', resolvedTargetCount: 1, unresolvedTargetCount: 0 }],
      airports: [{ id: 'KSBA', faaId: 'SBA', icaoId: 'KSBA', name: 'TEST AIRPORT', city: 'SANTA BARBARA',
        state: 'CA', volumeId: 'SW2', military: false, sortCode: '1', procedures: [{ id: 'test-approach', kind: 'approach',
          name: 'TEST APPROACH', sortOrder: 1, pdfName: 'TEST.PDF', pdfUrl: 'TEST.PDF', namedDestination: null,
          volumeTarget: { volumeId: 'SW2', section: null, printedPage: '1', pageIndex: 0 },
          source: { ...source, chartSequence: '1', chartCode: 'IAP', extraFields: {} } }] }],
    });
    add(`${root}/cs/catalog.json`, { schemaVersion: 2, builderVersion: 2, effectiveDate: revision, expirationDate, generatedAt,
      sourceXml: { url: 'test', sha256: 'a'.repeat(64) }, volumes: [{ ...volume, id: 'SW' }],
      expected: [{ faaId: 'SBA', state: 'CALIFORNIA', volumeId: 'SW', printedPage: '1' }],
      airports: [{ faaId: 'SBA', name: 'TEST AIRPORT', city: 'SANTA BARBARA', state: 'CALIFORNIA',
        volumeId: 'SW', printedPage: '1', pageIndex: 0 }] });
  }
  add('/weather/metars.geojson', { type: 'FeatureCollection', features: [] });
  add('/route-approaches.json', JSON.parse(await readFile(new URL('../fixtures/route-approaches.json', import.meta.url), 'utf8')));
  add('/route-approach-legs.json', JSON.parse(await readFile(new URL('../fixtures/route-approach-legs.json', import.meta.url), 'utf8')));
  add('/basemap.png', png, 'image/png');
  add('/georeferenced-book.pdf', pdf(true), 'application/pdf');
  return files;
}
