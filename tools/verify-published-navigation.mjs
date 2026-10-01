// node --import=tsx tools/verify-published-navigation.mjs <charts-root> <edition> <report.json>
import assert from 'node:assert/strict';
import { createReadStream, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { isChartSupplementCatalog, isNavigationManifest } from '@zlayer/contracts';
import { fetchChartCatalog } from '../src/workspace/catalog/catalog.ts';
import { referenceGuard } from '../src/core/data/references.ts';
const [root, edition, output] = process.argv.slice(2);
if (!root || !edition || !output) throw Error('Expected charts root, edition and report path');
const local = url => resolve(root, new URL(url).pathname.replace(/^\/charts\//, ''));
const verifyBook = async (volume, catalogUrl, folder) => {
  const url = new URL(volume.url, catalogUrl);
  assert.match(url.pathname, new RegExp(`/charts/\\d{4}-\\d{2}-\\d{2}/${folder}/${folder}-[a-z0-9]+\\.pdf$`));
  const file = local(url.href);
  assert.equal(statSync(file).size, volume.byteLength, url.href);
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(file)) digest.update(bytes);
  assert.equal(digest.digest('hex'), volume.sha256, url.href);
};
const nav = JSON.parse(readFileSync(resolve(root, edition, 'nav/manifest.json')));
assert.ok(isNavigationManifest(nav));
for (const product of nav.products) {
  const bytes = readFileSync(resolve(root, edition, 'nav', product.file));
  assert.equal(bytes.length, product.bytes, product.id);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), product.sha256, product.id);
}
const original = globalThis.fetch;
globalThis.fetch = async input => {
  try { return new Response(readFileSync(local(String(input))), { headers: { 'content-type': 'application/json' } }); }
  catch (error) { if (error.code === 'ENOENT') return new Response(null, { status: 404 }); throw error; }
};
try {
  const catalog = await fetchChartCatalog(edition);
  assert.deepEqual(catalog.issues, []);
  const resources = [...catalog.navigation, catalog.airways, catalog.preferredRoutes, catalog.terminalProcedures, catalog.routeHistory, catalog.procedures];
  for (const resource of resources) {
    assert.ok(resource, 'Required published resource');
    let bytes = readFileSync(local(resource.url));
    if (resource.id === 'route-history') bytes = gunzipSync(bytes);
    assert.ok(referenceGuard(resource, edition)(JSON.parse(bytes)), resource.id);
  }
  const plates = JSON.parse(readFileSync(local(catalog.procedures.url)));
  if (catalog.procedures.associationStatus === 'available') {
    assert.equal(plates.associations.sources.terminalJsonSha256, catalog.terminalProcedures.jsonSha256);
  } else assert.equal(plates.associations, undefined);
  const supplements = JSON.parse(readFileSync(resolve(root, edition, 'cs/catalog.json')));
  assert.ok(isChartSupplementCatalog(supplements));
  for (const volume of plates.volumes) await verifyBook(volume, catalog.procedures.url,
    volume.id === 'PC1' ? 'cs' : 'tpp');
  for (const volume of supplements.volumes) await verifyBook(volume,
    `https://charts.tedyin.com/charts/${edition}/cs/catalog.json`, 'cs');
  const report = { edition, resources: resources.map(r => ({ id: r.id, url: r.url, jsonSha256: r.jsonSha256 })),
    terminalCoverage: catalog.terminalProcedures.coverage,
    associationStatus: catalog.procedures.associationStatus,
    ...(plates.associations ? { associations: Object.fromEntries(['matched', 'ambiguous', 'unmatched']
      .map(status => [status, plates.associations.records.filter(r => r.status === status).length])),
      reviewedAssociations: plates.associations.records.filter(r => r.rule === 'reviewed').length } : {}),
    pdfBooksVerified: plates.volumes.length + supplements.volumes.length,
    supplements: { available: supplements.airports.length, books: supplements.volumes.length } };
  writeFileSync(output, JSON.stringify(report, null, 2)+'\n');
  console.log('Real publisher manifests, file identities, consumer guards and supplement targets passed.');
} finally { globalThis.fetch = original; }
