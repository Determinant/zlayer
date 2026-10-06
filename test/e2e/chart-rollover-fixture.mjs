import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

// Real download formats, tiny synthetic bytes. Model the publisher's separate
// 28-day navigation/TPP and 56-day raster/book editions without live FAA requests.
export function publishChartRollover(files, original, options) {
  const full = options.edition === 'full';
  const date = full ? '2026-10-29' : '2026-10-01';
  const expiry = full ? '2026-11-26' : '2026-10-29';
  const base = '/chart-data/2026-09-03', root = `/chart-data/${date}`;
  const set = (url, value) => files.set(url, { type: 'application/json', body: Buffer.from(JSON.stringify(value)) });
  const get = url => JSON.parse(files.get(url).body);
  const retime = text => text.replaceAll('2026-10-01', expiry).replaceAll('2026-09-03', date)
    .replaceAll('"cycle":"2609"', `"cycle":"${full ? '2611' : '2610'}"`)
    .replaceAll('/d-tpp/2609/', `/d-tpp/${full ? '2611' : '2610'}/`);
  for (const [url, file] of original) {
    if (!url.startsWith(`${base}/`) || (!full && (url.includes('/mbtiles/') || url.endsWith('.pdf')))) continue;
    const target = url.replace(base, root);
    files.set(target, file.type.includes('json') ? { ...file, body: Buffer.from(retime(file.body.toString())) }
      : url.endsWith('.json.gz') ? { ...file, body: gzipSync(retime(gunzipSync(file.body).toString())) } : file);
  }
  const nav = get(`${root}/nav/manifest.json`);
  const history = nav.products.find(product => product.id === 'route-history');
  const compressed = files.get(`${root}/nav/${history.file}`).body;
  history.bytes = compressed.length; history.uncompressedBytes = gunzipSync(compressed).length;
  set(`${root}/nav/manifest.json`, nav);
  const supplements = get(`${root}/cs/catalog.json`);
  delete supplements.expected; supplements.schemaVersion = 3;
  supplements.effectiveDate = full ? date : '2026-09-03';
  supplements.expirationDate = full ? '2026-12-24' : expiry;
  if (!full) supplements.volumes[0].url = '../../2026-09-03/cs/book.pdf';
  set(`${root}/cs/catalog.json`, supplements);
  if (!full) {
    const catalog = get(`${root}/tpp/catalog.json`);
    catalog.volumes[0].url = '../../2026-09-03/tpp/book.pdf';
    const body = Buffer.concat([original.get(`${base}/tpp/book.pdf`).body, Buffer.from('\n% change notice\n')]);
    const volume = { id: 'CN', url: 'notice.pdf', byteLength: body.length,
      sha256: createHash('sha256').update(body).digest('hex'), pageCount: 1, resolvedTargetCount: 1, unresolvedTargetCount: 0 };
    catalog.volumes.push(volume);
    const procedure = structuredClone(catalog.airports[0].procedures[0]);
    procedure.id = 'notice-approach'; procedure.name = 'NOTICE APPROACH'; procedure.sortOrder = 2;
    procedure.volumeTarget.volumeId = 'CN'; procedure.source.changeNoticePage = '1';
    catalog.airports[0].procedures.push(procedure);
    set(`${root}/tpp/catalog.json`, catalog);
    set(`${root}/tpp/manifest.json`, { ...get(`${root}/tpp/manifest.json`), procedureCount: 2 });
    files.set(`${root}/tpp/notice.pdf`, { body, type: 'application/pdf' });
    if (options.missingNotice) files.delete(`${root}/tpp/notice.pdf`);
  }
  if (options.onlyLatest) for (const url of files.keys()) {
    if (/^\/chart-data\/\d{4}-\d{2}-\d{2}\//.test(url) && !url.startsWith(`${root}/`)) files.delete(url);
  }
  const previous = options.onlyLatest ? [] : get('/chart-data/cycles.json').cycles;
  const cycles = [...new Set([date, ...previous])].sort().reverse();
  set('/chart-data/cycles.json', { schemaVersion: 1, generatedAt: `${date}T00:00:00Z`,
    cycles, rasterCycles: cycles.filter(cycle => files.has(`/chart-data/${cycle}/mbtiles/manifest.json`)) });
}
